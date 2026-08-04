/**
 * Reporting an envelope.
 *
 * The thing that makes this harder than a form: the content being reported is
 * not guaranteed to survive long enough for anyone to look at it. In a room
 * with retention, or one where the sender can redact, "I reported it" and
 * "a moderator can see what I reported" are different claims. Everything below
 * is shaped around keeping that distinction visible instead of assuming the
 * subject will still be there.
 */

export type EventId = string;
export type UserId = string;
export type RoomId = string;
export type ReportId = string;
export type CategoryId = string;

/** Enough of an envelope to report it and to show what is being reported. */
export interface ReportableEnvelope {
  id: EventId;
  roomId: RoomId;
  sender: UserId;
  originTs: number;
  preview: {
    kind: 'text' | 'media' | 'mixed';
    text?: string;
    mediaSummary?: string;
  };
  /** null = kept forever. Drives whether evidence capture matters. */
  expiresAt: number | null;
  redactedAt?: number;
}

export interface ReportCategory {
  id: CategoryId;
  label: string;
  /** Shown under the label in the picker. Rooms write these. */
  description?: string;
  requiresNote: boolean;
  severity: 'low' | 'medium' | 'high';
}

export interface ReportDraft {
  subjectId: EventId;
  categoryId: CategoryId | null;
  note: string;
  anonymous: boolean;
}

/**
 * A snapshot of the reported content, taken at report time.
 *
 * This is the crux. Without it a report is a pointer, and pointers to expired
 * content resolve to nothing. With it, the report is a copy of exactly the
 * content the room's retention policy exists to delete — which is a real
 * privacy cost, not an obvious win. `include_content_copy` is the room's call
 * and both answers are defensible.
 */
export interface Evidence {
  capturedAt: number;
  senderAtCapture: UserId;
  originTs: number;
  contentSnapshot: string;
  /** What the subject's expiry was when we captured. For retention audits. */
  subjectExpiresAt: number | null;
}

export type ReportDestination = 'room_moderators' | 'homeserver' | 'external_service';

export interface Report {
  id: ReportId;
  subject: ReportableEnvelope;
  category: ReportCategory;
  note: string | null;
  /** null when submitted anonymously. */
  reporter: UserId | null;
  createdAt: number;
  destination: ReportDestination;
  evidence: Evidence | null;
}

/** A previously submitted report, for cooldown and duplicate checks. */
export interface ReportRecord {
  id: ReportId;
  subjectId: EventId;
  categoryId: CategoryId;
  reporter: UserId | null;
  createdAt: number;
}

export const shortName = (userId: UserId): string => userId.replace(/^@/, '').split(':')[0];

export function previewText(envelope: ReportableEnvelope): string {
  if (envelope.redactedAt) return 'Message deleted';
  return envelope.preview.text ?? envelope.preview.mediaSummary ?? '(no preview)';
}
