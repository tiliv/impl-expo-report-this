/**
 * Validating and building a report.
 *
 * Validation returns a list rather than throwing on the first problem, because
 * a report form that reveals its objections one at a time is how you get a
 * user who gives up half way through reporting harassment.
 *
 * Issues are split by whether they *stop* the report. A subject that is about
 * to expire does not block submission — it changes what the report needs to
 * carry, and the user should be told, not stopped.
 */

import type { ReportSettings } from './settings';
import type {
  Evidence,
  Report,
  ReportCategory,
  ReportDraft,
  ReportRecord,
  ReportableEnvelope,
  UserId,
} from './types';
import { previewText } from './types';

export type IssueCode =
  | 'category_required'
  | 'unknown_category'
  | 'note_required'
  | 'note_too_long'
  | 'self_report_blocked'
  | 'anonymous_not_allowed'
  | 'cooldown_active'
  | 'duplicate_report'
  | 'subject_redacted'
  | 'subject_expiring_no_evidence'
  | 'subject_already_expired';

export interface Issue {
  code: IssueCode;
  /** `error` blocks submission. `notice` informs and lets it through. */
  level: 'error' | 'notice';
  message: string;
}

export interface ValidationContext {
  reporter: UserId;
  now: number;
  history: ReportRecord[];
}

export function findCategory(
  settings: ReportSettings,
  id: string | null,
): ReportCategory | undefined {
  return id === null ? undefined : settings.categories.value.find((c) => c.id === id);
}

export function validateDraft(
  draft: ReportDraft,
  subject: ReportableEnvelope,
  settings: ReportSettings,
  ctx: ValidationContext,
): Issue[] {
  const issues: Issue[] = [];
  const category = findCategory(settings, draft.categoryId);

  if (draft.categoryId === null) {
    issues.push({ code: 'category_required', level: 'error', message: 'Choose a reason.' });
  } else if (!category) {
    // Reachable in practice: the room can rewrite its category list while a
    // report sheet is open.
    issues.push({
      code: 'unknown_category',
      level: 'error',
      message: 'That reason is no longer offered in this room. Choose another.',
    });
  }

  const note = draft.note.trim();
  if (category?.requiresNote && note.length === 0) {
    issues.push({
      code: 'note_required',
      level: 'error',
      message: `"${category.label}" needs a short description.`,
    });
  }
  if (note.length > settings.maxNoteChars.value) {
    issues.push({
      code: 'note_too_long',
      level: 'error',
      message: `Keep it under ${settings.maxNoteChars.value} characters.`,
    });
  }

  if (subject.sender === ctx.reporter && !settings.allowSelfReport.value) {
    issues.push({
      code: 'self_report_blocked',
      level: 'error',
      message: 'You cannot report your own message in this room.',
    });
  }

  if (draft.anonymous && !settings.allowAnonymous.value) {
    issues.push({
      code: 'anonymous_not_allowed',
      level: 'error',
      message: 'This room requires reports to be attributable.',
    });
  }

  // --- history ------------------------------------------------------------

  const mine = ctx.history.filter((r) => r.reporter === ctx.reporter || r.reporter === null);

  if (mine.some((r) => r.subjectId === subject.id && r.categoryId === draft.categoryId)) {
    issues.push({
      code: 'duplicate_report',
      level: 'error',
      message: 'You have already reported this message for that reason.',
    });
  } else {
    const cooldown = settings.cooldownMs.value;
    const lastAt = mine.reduce((latest, r) => Math.max(latest, r.createdAt), 0);
    if (cooldown > 0 && lastAt > 0 && ctx.now - lastAt < cooldown) {
      const waitS = Math.ceil((cooldown - (ctx.now - lastAt)) / 1000);
      issues.push({
        code: 'cooldown_active',
        level: 'error',
        message: `Too many reports at once. Try again in ${waitS}s.`,
      });
    }
  }

  // --- the subject's own mortality ---------------------------------------

  if (subject.redactedAt !== undefined) {
    issues.push({
      code: 'subject_redacted',
      level: 'notice',
      message: settings.includeContentCopy.value
        ? 'This message was already deleted. The report will carry what we still hold.'
        : 'This message was already deleted and the report carries no copy. Moderators may see nothing.',
    });
  }

  if (subject.expiresAt !== null) {
    if (ctx.now >= subject.expiresAt) {
      issues.push({
        code: 'subject_already_expired',
        level: 'notice',
        message: settings.includeContentCopy.value
          ? 'This message has expired. The report will carry the copy we captured.'
          : 'This message has expired and the report carries no copy of it.',
      });
    } else if (!settings.includeContentCopy.value) {
      const minutes = Math.max(1, Math.round((subject.expiresAt - ctx.now) / 60_000));
      issues.push({
        code: 'subject_expiring_no_evidence',
        level: 'notice',
        message: `This message expires in about ${minutes}m and the report will not include a copy.`,
      });
    }
  }

  return issues;
}

export const blocking = (issues: Issue[]): Issue[] => issues.filter((i) => i.level === 'error');

/**
 * Capture the content into the report.
 *
 * Only called when the room says so. The snapshot is deliberately a flat
 * string rather than a structured copy: the goal is evidence a human can read
 * later, not a re-renderable message, and a smaller copy of expiring content
 * is the better privacy trade.
 */
export function captureEvidence(subject: ReportableEnvelope, now: number): Evidence {
  return {
    capturedAt: now,
    senderAtCapture: subject.sender,
    originTs: subject.originTs,
    contentSnapshot: previewText(subject),
    subjectExpiresAt: subject.expiresAt,
  };
}

export type BuildResult =
  | { ok: true; report: Report; notices: Issue[] }
  | { ok: false; issues: Issue[] };

let reportSeq = 0;

export function buildReport(
  draft: ReportDraft,
  subject: ReportableEnvelope,
  settings: ReportSettings,
  ctx: ValidationContext,
): BuildResult {
  const issues = validateDraft(draft, subject, settings, ctx);
  const errors = blocking(issues);
  if (errors.length > 0) return { ok: false, issues };

  const category = findCategory(settings, draft.categoryId);
  if (!category) return { ok: false, issues };

  const note = draft.note.trim();
  return {
    ok: true,
    notices: issues,
    report: {
      id: `report-${++reportSeq}`,
      subject,
      category,
      note: note.length > 0 ? note : null,
      reporter: draft.anonymous ? null : ctx.reporter,
      createdAt: ctx.now,
      destination: settings.destination.value,
      evidence: settings.includeContentCopy.value ? captureEvidence(subject, ctx.now) : null,
    },
  };
}

export const emptyDraft = (subjectId: string): ReportDraft => ({
  subjectId,
  categoryId: null,
  note: '',
  anonymous: false,
});
