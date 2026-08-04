/**
 * A report, packed for the only channel that will carry one.
 *
 * ## The finding: there is nowhere to send a report
 *
 * `noodles-model/openapi/paths/` has no report, moderation or abuse route.
 * `messaging-lambda/src/main.rs` has no such handler. Reporting is not
 * unimplemented-but-designed — it is absent from the contract entirely.
 *
 * That leaves exactly three channels a client can reach, and two of them are
 * wrong:
 *
 * - **A room event.** Wrong: everyone in the room can read it, including the
 *   person being reported.
 * - **A new endpoint.** Doesn't exist. Needs spec, lambda, storage and a
 *   moderator-facing surface that also does not exist.
 * - **An Olm to-device message to a moderator's devices.** Available today, and
 *   what this file packs. `ToDeviceEventType` restricts client-originated
 *   to-device events to `m.room.encrypted`, which is exactly the Olm envelope,
 *   and `keys/query` has no contact requirement — so a client can fetch a
 *   moderator's device keys without being their contact.
 *
 * ## The part that is not a packaging problem
 *
 * End-to-end encryption means the server cannot read the reported content, so a
 * report that is only a *pointer* is unactionable: the moderator would have to be
 * in the room, holding the room key, before the report arrived. Which means
 * moderating E2EE content requires the reporter to hand over a **copy, encrypted
 * to the moderator** — see `Evidence`.
 *
 * That is a deliberate hole in the confidentiality guarantee, opened by the
 * person who was harmed, and it cannot be closed by writing this code more
 * carefully. What this file can do is make it explicit rather than incidental,
 * and make "the report will be actionable" a claim the UI only makes when it is
 * true. `reportability()` is that check.
 *
 * Three ways the subject can be unreachable by the time a moderator looks:
 * revoked by the sender, past the room's retention, or view-once media that has
 * already been viewed (`viewOnce` flips UPLOADED → VIEWED and 410s the second
 * download). Only the first is visible locally.
 */

import {
  asNumber,
  asString,
  decodeWire,
  isRecord,
  makeTxnId,
  wireTimestampMs,
  type DecodedEnvelope,
  type WireEvent,
} from './envelope';
import type { Evidence, ReportableEnvelope, ReportDraft, ReportId, UserId } from './types';

/**
 * The inner plaintext type for a report.
 *
 * Ours entirely. Matrix's `m.room.report` does not exist; Matrix reporting is a
 * server API (`/report/{eventId}`), which is precisely what we do not have.
 */
export const REPORT_EVENT_TYPE = 'app.report.submit';

/** The to-device wrapper type the spec permits. Not ours to choose. */
export const TO_DEVICE_EVENT_TYPE = 'm.room.encrypted';

/** Why a report would reach a moderator with nothing to look at. */
export type UnactionableReason =
  /** The sender has already unsent it. Visible locally. */
  | 'subject_revoked'
  /** The room's retention window has closed. Computable locally. */
  | 'subject_expired'
  /**
   * The room forbids attaching a content copy, so the report is a bare pointer
   * into a room the moderator is not in.
   */
  | 'no_evidence_permitted'
  /**
   * The subject is view-once media. Whether it is still fetchable is not
   * knowable from here — only the server knows if it has been viewed.
   */
  | 'subject_may_be_view_once';

export interface Reportability {
  /** True when a moderator will have something to look at. */
  actionable: boolean;
  reasons: UnactionableReason[];
}

export interface ReportabilityContext {
  nowMs: number;
  /** From the room's `include_content_copy` setting. */
  evidencePermitted: boolean;
  /** True when any part of the subject is view-once media. */
  subjectIsViewOnce?: boolean;
}

/**
 * Will this report be actionable?
 *
 * Returns every reason rather than the first, because the UI shows them together
 * and because "expired *and* no evidence allowed" is a different conversation
 * from either alone.
 */
export function reportability(subject: ReportableEnvelope, ctx: ReportabilityContext): Reportability {
  const reasons: UnactionableReason[] = [];

  if (subject.redactedAt !== undefined) reasons.push('subject_revoked');
  if (subject.expiresAt !== null && subject.expiresAt <= ctx.nowMs) reasons.push('subject_expired');
  if (!ctx.evidencePermitted) reasons.push('no_evidence_permitted');
  if (ctx.subjectIsViewOnce === true) reasons.push('subject_may_be_view_once');

  // An evidence copy rescues a revoked or expired subject — that is the entire
  // reason it exists, and the reason it is a privacy cost rather than a free win.
  const rescued = ctx.evidencePermitted && !reasons.includes('no_evidence_permitted');
  const fatal = reasons.filter((r) => r !== 'subject_may_be_view_once');
  return { actionable: rescued || fatal.length === 0, reasons };
}

export interface PackReportInput {
  reportId: ReportId;
  draft: ReportDraft;
  subject: ReportableEnvelope;
  /** Omitted when the room forbids a content copy. */
  evidence?: Evidence;
  reporter: UserId;
  /** Devices to deliver to: moderator userId -> deviceIds. */
  moderatorDevices: Record<UserId, string[]>;
  seed: string | number;
}

/**
 * What a to-device send needs.
 *
 * Shaped after `SendToDeviceRequest`: a `messages` map keyed by userId then
 * deviceId. The same plaintext goes to every device, and the Olm layer encrypts
 * it once per device — so one report to a moderator with three devices is three
 * ciphertexts, not one.
 */
export interface OutgoingReport {
  /** Always `m.room.encrypted` — the only client-originated type permitted. */
  eventType: typeof TO_DEVICE_EVENT_TYPE;
  /** Idempotency, and the handle for revoking the to-device message. */
  txnId: string;
  /** Plaintext, before Olm. One copy per target device after encryption. */
  plaintext: { eventType: string; content: Record<string, unknown> };
  /** userId -> deviceId[]. Empty means the report has nowhere to go. */
  targets: Record<UserId, string[]>;
  /** How many Olm ciphertexts this will produce. */
  deviceCount: number;
}

export function packReport(input: PackReportInput): OutgoingReport {
  const content: Record<string, unknown> = {
    'app.report.id': input.reportId,
    'app.report.category': input.draft.categoryId,
    'app.report.subject': {
      event_id: input.subject.id,
      room_id: input.subject.roomId,
      sender: input.subject.sender,
      origin_ts: input.subject.originTs,
    },
    // Anonymity is *from the moderator*, not from the server: the Olm session is
    // between this device and theirs, so the sender identity is in the transport
    // whatever we put in the content. Omitting the field is the honest maximum,
    // and the UI must not promise more than that.
    'app.report.anonymous': input.draft.anonymous,
  };
  if (!input.draft.anonymous) content['app.report.reporter'] = input.reporter;
  if (input.draft.note.trim() !== '') content['app.report.note'] = input.draft.note.trim();
  if (input.evidence !== undefined) content['app.report.evidence'] = evidenceToWire(input.evidence);

  const targets: Record<UserId, string[]> = {};
  let deviceCount = 0;
  for (const [userId, devices] of Object.entries(input.moderatorDevices)) {
    const unique = [...new Set(devices)].filter((d) => d.length > 0);
    if (unique.length === 0) continue;
    targets[userId] = unique;
    deviceCount += unique.length;
  }

  return {
    eventType: TO_DEVICE_EVENT_TYPE,
    txnId: makeTxnId(input.seed, 'report'),
    plaintext: { eventType: REPORT_EVENT_TYPE, content },
    targets,
    deviceCount,
  };
}

/**
 * Evidence, field by field.
 *
 * Enumerated rather than spread on purpose: `Evidence` is the one type in this
 * repo whose contents leave the device, and a spread means the next field someone
 * adds to it starts being transmitted without anyone deciding that it should.
 */
function evidenceToWire(evidence: Evidence): Record<string, unknown> {
  return {
    captured_at: evidence.capturedAt,
    content_snapshot: evidence.contentSnapshot,
    sender_at_capture: evidence.senderAtCapture,
    origin_ts: evidence.originTs,
    // Carried so a moderator can tell whether they are looking at something the
    // room had already promised to delete.
    subject_expires_at: evidence.subjectExpiresAt,
  };
}

/** A report has somewhere to go. False means the submit button is a lie. */
export const isDeliverable = (report: OutgoingReport): boolean => report.deviceCount > 0;

// ── Receiving, from a moderator's side ──────────────────────────────────────

export interface ReceivedReport {
  reportId: ReportId;
  categoryId: string | null;
  note: string | null;
  /** Null when the report was filed anonymously. */
  reporter: UserId | null;
  subject: { eventId: string; roomId: string; sender: UserId; originTs: number };
  /** Absent when the room forbade a content copy — the report is a bare pointer. */
  evidence: {
    capturedAt: number;
    contentSnapshot: string;
    senderAtCapture: UserId;
    /** What the subject's expiry was at capture time. For retention audits. */
    subjectExpiresAt: number | null;
  } | null;
  receivedAtMs: number;
}

/**
 * Decode a report on the moderator's device.
 *
 * Included because a report nobody can read is not a feature, and the decode side
 * is where "the evidence is missing" has to become a visible state rather than an
 * empty field.
 */
export function unpackReport(wire: WireEvent): DecodedEnvelope<ReceivedReport> {
  return decodeWire<ReceivedReport>(
    wire,
    (_eventType, content) => {
      const reportId = asString(content['app.report.id']);
      const subject = content['app.report.subject'];
      if (reportId === null || !isRecord(subject)) return null;

      const eventId = asString(subject['event_id']);
      const roomId = asString(subject['room_id']);
      const sender = asString(subject['sender']);
      if (eventId === null || roomId === null || sender === null) return null;

      const rawEvidence = content['app.report.evidence'];
      const evidence = isRecord(rawEvidence)
        ? {
            capturedAt: asNumber(rawEvidence['captured_at']) ?? 0,
            contentSnapshot: asString(rawEvidence['content_snapshot']) ?? '',
            senderAtCapture: asString(rawEvidence['sender_at_capture']) ?? '',
            subjectExpiresAt: asNumber(rawEvidence['subject_expires_at']),
          }
        : null;

      return {
        reportId,
        categoryId: asString(content['app.report.category']),
        note: asString(content['app.report.note']),
        reporter: asString(content['app.report.reporter']),
        subject: { eventId, roomId, sender, originTs: asNumber(subject['origin_ts']) ?? 0 },
        evidence,
        receivedAtMs: wireTimestampMs(wire),
      };
    },
    (eventType) => eventType === REPORT_EVENT_TYPE,
  );
}

/**
 * Can the moderator act on what arrived?
 *
 * Deliberately a separate question from `reportability`, which the *reporter*
 * asks before sending. These can disagree — a report that was actionable when
 * filed arrives without evidence if the room's policy changed in between — and
 * that disagreement is the thing worth surfacing.
 */
export function canModeratorAct(report: ReceivedReport): { can: boolean; why: string } {
  if (report.evidence === null) {
    return {
      can: false,
      why: 'no content copy — the moderator is not in the room and cannot fetch it',
    };
  }
  if (report.evidence.contentSnapshot.trim() === '') {
    return { can: false, why: 'evidence present but the snapshot is empty' };
  }
  return { can: true, why: 'content copy attached' };
}
