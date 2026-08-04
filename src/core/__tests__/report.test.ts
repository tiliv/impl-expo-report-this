import { MINUTE } from '../clock';
import { RoomStateStore, stateEvent } from '../roomState';
import { blocking, buildReport, emptyDraft, validateDraft, type IssueCode } from '../report';
import { DEFAULT_CATEGORIES, resolveReportSettings, STATE_REPORT, STATE_RETENTION } from '../settings';
import { backoffMs, describeSubmission, submissionReducer, type SubmissionState } from '../submission';
import type { ReportDraft, ReportRecord, ReportableEnvelope } from '../types';
import { envelope, EPOCH, ExperimentWorld } from '../../experiment/world';
import { SCENARIOS } from '../../experiment/scenarios';

const YOU = '@you:example.org';
const THEM = '@stranger:example.org';

const settingsFrom = (content?: Record<string, unknown>, retentionSeconds?: number) => {
  const store = new RoomStateStore();
  if (content) store.send(stateEvent(STATE_REPORT, content));
  if (retentionSeconds) store.send(stateEvent(STATE_RETENTION, { max_lifetime: retentionSeconds }));
  return resolveReportSettings(store);
};

const subject = (over: Partial<ReportableEnvelope> = {}): ReportableEnvelope => ({
  ...envelope({ sender: THEM, text: 'offending message' }),
  ...over,
});

const draftOf = (over: Partial<ReportDraft> = {}): ReportDraft => ({
  ...emptyDraft('$s'),
  categoryId: 'spam',
  ...over,
});

const codes = (issues: { code: IssueCode }[]) => issues.map((i) => i.code);

describe('category resolution', () => {
  it('uses the built-in taxonomy when the room says nothing', () => {
    expect(settingsFrom().settings.categories.value).toEqual(DEFAULT_CATEGORIES);
  });

  it('lets a room define its own', () => {
    const { settings } = settingsFrom({
      categories: [{ id: 'off_topic', label: 'Off topic', severity: 'low' }],
    });
    expect(settings.categories.value.map((c) => c.id)).toEqual(['off_topic']);
    expect(settings.categories.source.kind).toBe('state_event');
  });

  it('drops bad entries individually rather than the whole list', () => {
    const { settings, warnings } = settingsFrom({
      categories: [
        { id: 'ok', label: 'A real one' },
        { label: 'no id' },
        'not an object',
        { id: 'ok', label: 'duplicate' },
        { id: 'nolabel' },
      ],
    });
    expect(settings.categories.value.map((c) => c.id)).toEqual(['ok']);
    expect(warnings.filter((w) => w.setting === 'categories').length).toBe(4);
  });

  it('falls back to defaults when nothing in the list is usable', () => {
    const { settings, warnings } = settingsFrom({ categories: [{ label: 'no id' }, 42] });
    expect(settings.categories.value).toEqual(DEFAULT_CATEGORIES);
    expect(warnings.some((w) => w.severity === 'danger')).toBe(true);
  });

  it('treats an empty list the same as an unusable one — reporting stays possible', () => {
    expect(settingsFrom({ categories: [] }).settings.categories.value).toEqual(DEFAULT_CATEGORIES);
  });
});

describe('validateDraft', () => {
  const ctx = { reporter: YOU, now: EPOCH, history: [] as ReportRecord[] };

  it('reports every objection at once, not one at a time', () => {
    const { settings } = settingsFrom({ allow_anonymous: false });
    const issues = validateDraft(
      draftOf({ categoryId: 'other', note: '', anonymous: true }),
      subject({ sender: YOU }),
      settings,
      ctx,
    );
    expect(codes(issues)).toEqual(
      expect.arrayContaining(['note_required', 'self_report_blocked', 'anonymous_not_allowed']),
    );
  });

  it('requires a note only for the categories that ask for one', () => {
    const { settings } = settingsFrom();
    expect(codes(validateDraft(draftOf({ categoryId: 'spam' }), subject(), settings, ctx))).not.toContain(
      'note_required',
    );
    expect(codes(validateDraft(draftOf({ categoryId: 'other' }), subject(), settings, ctx))).toContain(
      'note_required',
    );
  });

  it('handles the room withdrawing a category while the sheet is open', () => {
    const { settings } = settingsFrom({ categories: [{ id: 'off_topic', label: 'Off topic' }] });
    expect(codes(validateDraft(draftOf({ categoryId: 'spam' }), subject(), settings, ctx))).toContain(
      'unknown_category',
    );
  });

  it('blocks a duplicate but allows a different claim about the same message', () => {
    const { settings } = settingsFrom({ cooldown_ms: 0 });
    const target = subject();
    const history: ReportRecord[] = [
      { id: 'r1', subjectId: target.id, categoryId: 'spam', reporter: YOU, createdAt: EPOCH - MINUTE },
    ];
    const withHistory = { ...ctx, history };
    expect(codes(validateDraft(draftOf({ categoryId: 'spam' }), target, settings, withHistory))).toContain(
      'duplicate_report',
    );
    expect(
      codes(validateDraft(draftOf({ categoryId: 'harassment' }), target, settings, withHistory)),
    ).not.toContain('duplicate_report');
  });

  it('names the remaining cooldown, and lets it lapse', () => {
    const { settings } = settingsFrom({ cooldown_ms: 5 * MINUTE });
    const history: ReportRecord[] = [
      { id: 'r1', subjectId: '$other', categoryId: 'spam', reporter: YOU, createdAt: EPOCH - MINUTE },
    ];
    const blockedIssues = validateDraft(draftOf(), subject(), settings, { ...ctx, history });
    const cooldown = blockedIssues.find((i) => i.code === 'cooldown_active');
    expect(cooldown?.message).toMatch(/\d+s/);

    const later = validateDraft(draftOf(), subject(), settings, {
      ...ctx,
      history,
      now: EPOCH + 6 * MINUTE,
    });
    expect(codes(later)).not.toContain('cooldown_active');
  });

  it('prefers the duplicate message over the cooldown one', () => {
    const { settings } = settingsFrom({ cooldown_ms: 5 * MINUTE });
    const target = subject();
    const issues = validateDraft(draftOf({ categoryId: 'spam' }), target, settings, {
      ...ctx,
      history: [{ id: 'r1', subjectId: target.id, categoryId: 'spam', reporter: YOU, createdAt: EPOCH - MINUTE }],
    });
    expect(codes(issues)).toContain('duplicate_report');
    expect(codes(issues)).not.toContain('cooldown_active');
  });
});

describe('expiry and evidence', () => {
  const ctx = { reporter: YOU, now: EPOCH, history: [] as ReportRecord[] };

  it('warns, without blocking, when the subject will expire and no copy is kept', () => {
    const { settings } = settingsFrom({ include_content_copy: false }, 600);
    const issues = validateDraft(draftOf(), subject({ expiresAt: EPOCH + 4 * MINUTE }), settings, ctx);
    expect(codes(issues)).toContain('subject_expiring_no_evidence');
    expect(blocking(issues)).toHaveLength(0);
  });

  it('says nothing about expiry when a copy is captured', () => {
    const { settings } = settingsFrom({ include_content_copy: true }, 600);
    const issues = validateDraft(draftOf(), subject({ expiresAt: EPOCH + 4 * MINUTE }), settings, ctx);
    expect(codes(issues)).not.toContain('subject_expiring_no_evidence');
  });

  it('still allows reporting content that is already gone', () => {
    const { settings } = settingsFrom();
    const issues = validateDraft(draftOf(), subject({ redactedAt: EPOCH - MINUTE }), settings, ctx);
    expect(codes(issues)).toContain('subject_redacted');
    expect(blocking(issues)).toHaveLength(0);
  });

  it('flags the room-level combination of retention and no evidence', () => {
    const { warnings } = settingsFrom({ include_content_copy: false }, 600);
    expect(warnings.some((w) => w.severity === 'danger' && w.setting === 'includeContentCopy')).toBe(true);
  });

  it('flags evidence leaving the homeserver', () => {
    const { warnings } = settingsFrom({ include_content_copy: true, destination: 'external_service' });
    expect(warnings.some((w) => w.setting === 'destination')).toBe(true);
  });
});

describe('buildReport', () => {
  const ctx = { reporter: YOU, now: EPOCH, history: [] as ReportRecord[] };

  it('captures a snapshot only when the room asks for one', () => {
    const target = subject({ expiresAt: EPOCH + MINUTE });

    const withCopy = buildReport(draftOf(), target, settingsFrom({ include_content_copy: true }).settings, ctx);
    expect(withCopy.ok && withCopy.report.evidence?.contentSnapshot).toBe('offending message');
    expect(withCopy.ok && withCopy.report.evidence?.subjectExpiresAt).toBe(EPOCH + MINUTE);

    const without = buildReport(draftOf(), target, settingsFrom({ include_content_copy: false }).settings, ctx);
    expect(without.ok && without.report.evidence).toBeNull();
  });

  it('drops the reporter identity when anonymous', () => {
    const result = buildReport(draftOf({ anonymous: true }), subject(), settingsFrom().settings, ctx);
    expect(result.ok && result.report.reporter).toBeNull();
  });

  it('passes notices through on success', () => {
    const result = buildReport(
      draftOf(),
      subject({ expiresAt: EPOCH + MINUTE }),
      settingsFrom({ include_content_copy: false }, 600).settings,
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(result.ok && result.notices.map((i) => i.code)).toContain('subject_expiring_no_evidence');
  });

  it('refuses when anything blocking is present', () => {
    const result = buildReport(draftOf({ categoryId: null }), subject(), settingsFrom().settings, ctx);
    expect(result.ok).toBe(false);
  });
});

describe('submission', () => {
  const report = { id: 'r1' } as never;
  const submitting: SubmissionState = { status: 'submitting', report, attempt: 1 };

  it('queues retryable failures with backoff and gives up on rejections', () => {
    const queued = submissionReducer(submitting, {
      type: 'failed',
      failure: { kind: 'offline' },
      at: 1000,
    });
    expect(queued.status).toBe('queued');

    const rejected = submissionReducer(submitting, {
      type: 'failed',
      failure: { kind: 'rejected', reason: 'no' },
      at: 1000,
    });
    expect(rejected.status).toBe('failed');
  });

  it('honours a server retry-after over its own curve', () => {
    expect(backoffMs(1, { kind: 'rate_limited', retryAfterMs: 8000 })).toBe(8000);
    expect(backoffMs(1, { kind: 'offline' })).toBe(2000);
    expect(backoffMs(4, { kind: 'offline' })).toBe(16000);
    expect(backoffMs(20, { kind: 'offline' })).toBe(60000);
  });

  it('gives up after the attempt limit', () => {
    let state: SubmissionState = { status: 'submitting', report, attempt: 5 };
    state = submissionReducer(state, { type: 'failed', failure: { kind: 'offline' }, at: 0 });
    expect(state.status).toBe('failed');
  });

  it('resets the attempt count on a manual retry after giving up', () => {
    const failed: SubmissionState = { status: 'failed', report, failure: { kind: 'server_error', status: 502 } };
    const retried = submissionReducer(failed, { type: 'retry', at: 0 });
    expect(retried).toEqual({ status: 'submitting', report, attempt: 1 });
  });

  it('never calls a queued report sent', () => {
    const queued: SubmissionState = {
      status: 'queued',
      report,
      failure: { kind: 'offline' },
      attempt: 1,
      nextAttemptAt: 0,
    };
    expect(describeSubmission(queued).title).not.toMatch(/sent$/);
    expect(describeSubmission({ status: 'submitted', report, at: 0 }).title).toBe('Report sent');
  });
});

describe('scenarios', () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))('%s arranges and validates cleanly', (_id, scenario) => {
    const world = new ExperimentWorld();
    scenario.arrange(world);
    const { settings } = resolveReportSettings(world.stateStore);
    for (const target of world.envelopes()) {
      const issues = validateDraft(
        { ...emptyDraft(target.id), categoryId: settings.categories.value[0].id, note: 'because' },
        target,
        settings,
        { reporter: world.viewer, now: world.clock.now(), history: world.history() },
      );
      expect(Array.isArray(issues)).toBe(true);
    }
    expect(scenario.expect.length).toBeGreaterThan(0);
  });
});
