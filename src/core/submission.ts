/**
 * Getting the report to wherever it goes.
 *
 * Submission is a state machine rather than an awaited call because the
 * failure cases matter more than the happy path here. Someone reporting
 * harassment on a train is exactly the person whose connection drops mid-
 * submit, and "your report failed, try again" is the wrong answer — the report
 * should survive in a queue and go when it can.
 *
 * The queue is intentionally part of core: whether a report was *accepted by
 * the app* and whether it was *delivered* are different facts, and the UI has
 * to be able to tell the user which one it has.
 */

import type { Report, ReportId } from './types';

export type SubmissionFailure =
  /** Network or server unreachable. Retryable, and the report is kept. */
  | { kind: 'offline' }
  | { kind: 'server_error'; status: number }
  /** The destination rejected it. Retrying will not help. */
  | { kind: 'rejected'; reason: string }
  | { kind: 'rate_limited'; retryAfterMs: number };

export type SubmissionState =
  | { status: 'idle' }
  | { status: 'submitting'; report: Report; attempt: number }
  | { status: 'submitted'; report: Report; at: number }
  | { status: 'queued'; report: Report; failure: SubmissionFailure; attempt: number; nextAttemptAt: number }
  | { status: 'failed'; report: Report; failure: SubmissionFailure };

export type SubmissionAction =
  | { type: 'submit'; report: Report; at: number }
  | { type: 'succeeded'; at: number }
  | { type: 'failed'; failure: SubmissionFailure; at: number }
  | { type: 'retry'; at: number }
  | { type: 'discard' };

export const MAX_ATTEMPTS = 5;

/** Exponential with a ceiling; the server's own advice wins when it gives any. */
export function backoffMs(attempt: number, failure: SubmissionFailure): number {
  if (failure.kind === 'rate_limited') return failure.retryAfterMs;
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempt - 1));
}

export const isRetryable = (failure: SubmissionFailure): boolean =>
  failure.kind === 'offline' || failure.kind === 'server_error' || failure.kind === 'rate_limited';

export function submissionReducer(state: SubmissionState, action: SubmissionAction): SubmissionState {
  switch (action.type) {
    case 'submit':
      return { status: 'submitting', report: action.report, attempt: 1 };

    case 'succeeded':
      return state.status === 'submitting'
        ? { status: 'submitted', report: state.report, at: action.at }
        : state;

    case 'failed': {
      if (state.status !== 'submitting') return state;
      const giveUp = !isRetryable(action.failure) || state.attempt >= MAX_ATTEMPTS;
      if (giveUp) return { status: 'failed', report: state.report, failure: action.failure };
      return {
        status: 'queued',
        report: state.report,
        failure: action.failure,
        attempt: state.attempt,
        nextAttemptAt: action.at + backoffMs(state.attempt, action.failure),
      };
    }

    case 'retry': {
      if (state.status === 'queued') {
        return { status: 'submitting', report: state.report, attempt: state.attempt + 1 };
      }
      // A manual retry after giving up starts the attempt count over: the user
      // asking again is new information, not a continuation.
      if (state.status === 'failed') {
        return { status: 'submitting', report: state.report, attempt: 1 };
      }
      return state;
    }

    case 'discard':
      return { status: 'idle' };
  }
}

/**
 * What the user is told.
 *
 * Kept next to the machine so the wording cannot drift from the state, and so
 * "accepted" is never used for something that has not left the device.
 */
export function describeSubmission(state: SubmissionState): { title: string; detail: string } {
  switch (state.status) {
    case 'idle':
      return { title: '', detail: '' };
    case 'submitting':
      return {
        title: 'Sending report…',
        detail: state.attempt > 1 ? `Attempt ${state.attempt} of ${MAX_ATTEMPTS}` : 'Contacting moderators',
      };
    case 'submitted':
      return { title: 'Report sent', detail: 'Moderators can see it now.' };
    case 'queued':
      return {
        title: 'Report saved, not sent yet',
        detail:
          state.failure.kind === 'offline'
            ? 'You are offline. It will send by itself when you are back.'
            : `Retrying shortly (attempt ${state.attempt} of ${MAX_ATTEMPTS}).`,
      };
    case 'failed':
      return {
        title: 'Report not sent',
        detail:
          state.failure.kind === 'rejected'
            ? state.failure.reason
            : 'Gave up after several attempts. You can try again.',
      };
  }
}

export const pendingReportId = (state: SubmissionState): ReportId | null =>
  state.status === 'idle' ? null : state.report.id;
