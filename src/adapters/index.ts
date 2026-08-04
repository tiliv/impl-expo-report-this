/**
 * The seam.
 *
 * `src/core` is pure TypeScript. It needs three things from the app.
 * Integration should mean writing these and deleting `src/experiment`.
 */

import type { RoomStateStore } from '../core/roomState';
import type { Report, ReportRecord, ReportableEnvelope, EventId, UserId } from '../core/types';
import type { SubmissionFailure } from '../core/submission';

export type { Report, ReportRecord, ReportableEnvelope, SubmissionFailure };

export interface RoomStateSource {
  state(): RoomStateStore;
  subscribe(listener: () => void): () => void;
}

/**
 * Where reports go.
 *
 * Returns a failure rather than throwing, because the difference between
 * `offline` and `rejected` decides whether the report is queued or dropped,
 * and that decision must not depend on parsing an exception message.
 */
export interface ReportTransport {
  send(report: Report): Promise<{ ok: true } | { ok: false; failure: SubmissionFailure }>;
}

/**
 * Local record of what this user has already reported.
 *
 * Must be **local and durable**, not derived from the server. Cooldown and
 * duplicate checks have to work offline — a queued report still counts against
 * the cooldown, because the rule is about how often this person is filing, not
 * about what the server has acknowledged.
 *
 * It also has to survive the subject disappearing: keep records keyed by event
 * id even after the event expires, or a user can re-report the same vanished
 * message indefinitely.
 */
export interface ReportHistoryStore {
  records(): ReportRecord[];
  append(record: ReportRecord): Promise<void>;
  /** Local hide state from `hide_on_report`. */
  hiddenSubjects(): Set<EventId>;
  setHidden(id: EventId, hidden: boolean): Promise<void>;
}

/**
 * Mapping your event to `ReportableEnvelope`:
 *
 *   - `preview` should be what the *user currently sees*, not the raw content.
 *     If your timeline shows a redaction tombstone, the report sheet should
 *     show the same thing, or the user will think they are reporting something
 *     other than what they clicked.
 *   - `expiresAt` should come from the same retention calculation the timeline
 *     uses. Two different expiry answers in one app is a bug that surfaces as
 *     "it said I could report it and then said it was gone".
 */
export type { EventId, UserId };
