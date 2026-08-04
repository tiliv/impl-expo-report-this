/**
 * The wire boundary.
 *
 * Byte-identical across the `impl-expo-*` sandboxes, like `clock.ts` and
 * `roomState.ts`. It exists because every one of these experiments produces or
 * consumes a *room event*, and none of them showed what that actually is. This is
 * the file where the feature model meets the shape the Noodles API really moves.
 *
 * Everything here is derived from `noodles-model/openapi` and the send path in
 * `noodles-sdk/src/noodlesClient.ts`, not invented. The comments say which.
 *
 * ## Two envelopes, and only one of them is specified
 *
 * ```
 *   OutgoingEnvelope  { eventType, content }        ← ours. Nothing specifies it.
 *          │
 *          │  crypto.encryptRoomEvent(roomId, eventType, content)
 *          ▼
 *   PUT /rooms/{roomId}/send/m.room.encrypted/{txnId}   body: { content }
 *          │
 *          ▼
 *   WireEvent { eventId, txnId, senderUserId, eventType, content, createdAt, revoked }
 * ```
 *
 * The server stores `content` as `additionalProperties: {}` and the spec calls it
 * "opaque to server". So the **inner** plaintext envelope is entirely a client
 * concern, and the only example of one anywhere in the ecosystem is
 * `olm-demo/App.tsx`:
 *
 *     { eventType: 'm.room.message', content: { msgtype: 'm.text', body: '…' } }
 *
 * That is a plain Matrix `m.room.message`. Everything richer than a text line —
 * a reply, several attachments, a voice memo, a report — has no precedent, which
 * is what makes the choices in the per-feature `packing.ts` decisions rather than
 * transcriptions.
 *
 * ## Three facts that bite, all of them real
 *
 * 1. **`txnId` is the revocation handle, not a retry token.** The server derives
 *    `eventId` from `(txnId, senderUserId)`, and `POST /rooms/{id}/messages/revoke`
 *    takes `txnId` — not `eventId`. A client that generates a txnId, sends, and
 *    forgets it **cannot ever unsend that message.** It has to be persisted with
 *    the message, not scoped to the request.
 *
 * 2. **Revocation is media-aware and capped at ten.**
 *    `RevokeRoomMessageRequest.mediaIds` has `maxItems: 10`. Each listed id is
 *    marked REVOKED so its download 410s. An envelope carrying more than ten
 *    attachments therefore has media that **cannot be revoked with it** — the
 *    text goes, the files stay reachable. That is a ceiling on any
 *    multi-attachment feature, and it is not mentioned anywhere outside the spec.
 *
 * 3. **Media is room-scoped at upload time.** `MediaUploadInitRequest` requires
 *    `roomId`. So a staged attachment cannot be moved to another room by
 *    re-addressing the envelope; it has to be re-uploaded.
 */

// ── The outer event, as the server defines it ───────────────────────────────

/**
 * Mirrors `RoomEvent` in `noodles-model/openapi/components/schemas.yaml`.
 *
 * On the wire `eventType` is `'m.room.encrypted'` and `content` is ciphertext.
 * After `NoodlesClient.sync()` decrypts, both are replaced in place by the
 * cleartext values — the same object shape carries pre- and post-decryption
 * state, which is convenient and is also why `decodeWire` below has to be
 * careful about which one it is looking at.
 */
export interface WireEvent {
  eventId: string;
  /** The sender's own idempotency token. See fact 1 above. */
  txnId: string;
  senderUserId: string;
  /** `'m.room.encrypted'` before decryption; the inner type after. */
  eventType: string;
  content: Record<string, unknown>;
  /** ISO 8601, server-stamped. */
  createdAt: string;
  /** The sender has unsent this. Content may still be present but must not render. */
  revoked: boolean;
}

/** The wire event type for anything encrypted. Never an inner type. */
export const WIRE_EVENT_TYPE = 'm.room.encrypted';

/**
 * What a send needs, all in one object.
 *
 * `eventType` and `content` go to `encryptRoomEvent`; `txnId` goes in the path;
 * `mediaIds` is not sent at all — it is kept so the message can be revoked later.
 * Grouping them is the point: these four are a unit, and the ones that get
 * dropped in practice are the two that are not part of the HTTP body.
 */
export interface OutgoingEnvelope {
  /** The inner plaintext type, e.g. `'m.room.message'`. Ours to choose. */
  eventType: string;
  content: Record<string, unknown>;
  /** Must be persisted with the message. Without it there is no unsend. */
  txnId: string;
  /**
   * Media referenced by this envelope, for the eventual revoke call.
   *
   * May exceed `MEDIA_IDS_PER_REVOCATION`, deliberately — truncating here would
   * hide the problem. `revocationPlan` reports what cannot be covered.
   */
  mediaIds: string[];
}

/** `RevokeRoomMessageRequest.mediaIds` — `maxItems: 10` in the spec. */
export const MEDIA_IDS_PER_REVOCATION = 10;

/**
 * What revoking this envelope would actually achieve.
 *
 * Split out rather than folded into a boolean because the failure is partial:
 * the message is always revocable, and some of its media may not be. A composer
 * that offers "unsend" without knowing this promises something it cannot deliver.
 */
export interface RevocationPlan {
  txnId: string;
  /** Passed to the revoke endpoint. At most `MEDIA_IDS_PER_REVOCATION`. */
  mediaIds: string[];
  /**
   * Media that will stay downloadable after the revoke.
   *
   * Non-empty means the UI must either say so or refuse to send the envelope in
   * the first place. Silently leaving these reachable is the worst of the three.
   */
  unrevocable: string[];
}

export function revocationPlan(envelope: Pick<OutgoingEnvelope, 'txnId' | 'mediaIds'>): RevocationPlan {
  return {
    txnId: envelope.txnId,
    mediaIds: envelope.mediaIds.slice(0, MEDIA_IDS_PER_REVOCATION),
    unrevocable: envelope.mediaIds.slice(MEDIA_IDS_PER_REVOCATION),
  };
}

/** True when every attachment on this envelope can be taken back with it. */
export const isFullyRevocable = (envelope: Pick<OutgoingEnvelope, 'mediaIds'>): boolean =>
  envelope.mediaIds.length <= MEDIA_IDS_PER_REVOCATION;

// ── Encrypted media references ──────────────────────────────────────────────

/**
 * A reference to one encrypted blob, carried inside the envelope content.
 *
 * Shaped after Matrix's `EncryptedFile` (the `v2` that
 * `MediaUploadInitRequest.encryptionVersion` names), with one substitution:
 * Matrix puts an `mxc://` URL in `url`, and we have a `mediaId` plus a
 * per-room download call. So `mediaId` replaces `url`.
 *
 * **The key travels in the envelope.** That is the whole design: the server
 * holds ciphertext it cannot read, and the only copy of the key is inside the
 * Megolm-encrypted event. Which means a lost room key loses the media too, not
 * just the text — and it means a media reference is worthless outside the
 * envelope that carried it.
 */
export interface EncryptedFileRef {
  mediaId: string;
  /** JWK, as Matrix does it. `k` is the urlsafe-base64 AES key. */
  key: { alg: 'A256CTR'; ext: true; k: string; key_ops: string[]; kty: 'oct' };
  /** Base64 AES-CTR initialisation vector. */
  iv: string;
  /** `{ sha256: base64 }` of the *ciphertext*, matching `sha256CiphertextB64`. */
  hashes: Record<string, string>;
  v: 'v2';
  /** MIME type of the decrypted bytes. */
  mimetype: string;
  /** Ciphertext length, which is what the upload reported. */
  sizeBytes: number;
  /**
   * True when the server will 410 the second download.
   *
   * From `MediaUploadInitRequest.viewOnce`: the first download atomically flips
   * UPLOADED → VIEWED. A UI that retries a failed download, or that prefetches,
   * will burn the single view — so this has to be visible to the renderer, not
   * just to the uploader.
   */
  viewOnce?: boolean;
}

// ── Relations ───────────────────────────────────────────────────────────────

/**
 * Our reply pointer.
 *
 * Deliberately not `m.relates_to` / `m.in_reply_to`. Matrix's reply convention
 * carries a *fallback quote* — the parent's text prefixed with `> ` inside the
 * child's own body — so that clients which do not understand replies still show
 * something. That fallback is exactly wrong here: it copies the parent's content
 * into the child, which survives the parent's revocation and defeats retention.
 * A reply whose quote is rendered from the resolved parent shows a tombstone when
 * the parent is gone; a reply carrying a fallback quote shows the words forever.
 *
 * So: same idea, our namespace, no fallback, quote rendered from the parent only.
 */
export interface ReplyRelation {
  rel_type: 'app.envelope.reply';
  event_id: string;
}

export const REPLY_REL_TYPE = 'app.envelope.reply';

export const replyRelation = (eventId: string): ReplyRelation => ({
  rel_type: REPLY_REL_TYPE,
  event_id: eventId,
});

/** Reads a relation off arbitrary decrypted content, tolerating anything. */
export function readReplyRelation(content: unknown): ReplyRelation | null {
  if (!isRecord(content)) return null;
  const rel = content['app.envelope.relates_to'];
  if (!isRecord(rel)) return null;
  if (rel['rel_type'] !== REPLY_REL_TYPE) return null;
  const eventId = rel['event_id'];
  return typeof eventId === 'string' && eventId.length > 0 ? replyRelation(eventId) : null;
}

/** The content key a relation lives under. Ours, so it is namespaced. */
export const RELATES_TO_KEY = 'app.envelope.relates_to';

// ── Decoding what arrives ───────────────────────────────────────────────────

/**
 * Why a received event cannot be rendered as itself.
 *
 * These are the states a timeline has to draw, and they are not
 * interchangeable — which is the same argument as the discard reasons in the
 * voice-memo sandbox, one layer down.
 */
export type UndecodableReason =
  /** Sender unsent it. `revoked: true` on the wire event. */
  | 'revoked'
  /** Still ciphertext: `eventType` is `m.room.encrypted` after a decrypt attempt. */
  | 'undecrypted'
  /** Decrypted fine, but the inner type is one this client does not render. */
  | 'unknown_type'
  /** Right type, content fails its own shape check. */
  | 'malformed';

export type DecodedEnvelope<T> =
  | { ok: true; value: T; wire: WireEvent }
  | { ok: false; reason: UndecodableReason; wire: WireEvent; detail?: string };

/**
 * Turn a wire event into a feature model, or say precisely why not.
 *
 * The `revoked` check comes first and unconditionally. A revoked event may still
 * arrive with readable content — the server marks it rather than erasing it — so
 * anything that decodes before checking will happily render an unsent message.
 * That ordering is the single most important line in this file.
 */
export function decodeWire<T>(
  wire: WireEvent,
  parse: (eventType: string, content: Record<string, unknown>) => T | null,
  accepts: (eventType: string) => boolean,
): DecodedEnvelope<T> {
  if (wire.revoked) return { ok: false, reason: 'revoked', wire };
  if (wire.eventType === WIRE_EVENT_TYPE) return { ok: false, reason: 'undecrypted', wire };
  if (!accepts(wire.eventType)) {
    return { ok: false, reason: 'unknown_type', wire, detail: wire.eventType };
  }
  const value = parse(wire.eventType, wire.content);
  if (value === null) return { ok: false, reason: 'malformed', wire };
  return { ok: true, value, wire };
}

/** Server timestamps are ISO strings; everything local is epoch ms. */
export function wireTimestampMs(wire: WireEvent): number {
  const parsed = Date.parse(wire.createdAt);
  // An unparseable timestamp must not become NaN and poison every expiry
  // comparison downstream — 0 sorts to the beginning and is obviously wrong.
  return Number.isFinite(parsed) ? parsed : 0;
}

// ── Transaction ids ─────────────────────────────────────────────────────────

/** `RevokeRoomMessageRequest.txnId` is `maxLength: 255`. */
export const TXN_ID_MAX_LENGTH = 255;

/**
 * Mint a transaction id.
 *
 * Takes its entropy as an argument rather than calling `Math.random`, for the
 * same reason nothing here calls `Date.now()`: a txnId that cannot be reproduced
 * cannot be asserted on, and this one has to survive into persistence.
 */
export function makeTxnId(seed: string | number, prefix = 'n'): string {
  return `${prefix}-${seed}`.slice(0, TXN_ID_MAX_LENGTH);
}

export const isUsableTxnId = (txnId: string): boolean =>
  txnId.length > 0 && txnId.length <= TXN_ID_MAX_LENGTH;

// ── Helpers ─────────────────────────────────────────────────────────────────

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

export const asNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;
