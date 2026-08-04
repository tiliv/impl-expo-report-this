/**
 * Packing a report, and the fact that there is nowhere to put one.
 *
 * The interesting assertions here are not round-trips. They are the ones that
 * pin down when a report is a lie: no target devices, no evidence, or a subject
 * that will be gone before anyone looks.
 */

import type { WireEvent } from '../envelope';
import {
  canModeratorAct,
  isDeliverable,
  packReport,
  reportability,
  REPORT_EVENT_TYPE,
  TO_DEVICE_EVENT_TYPE,
  unpackReport,
} from '../packing';
import type { Evidence, ReportableEnvelope, ReportDraft } from '../types';

const NOW = 1_780_000_000_000;

const subject = (over: Partial<ReportableEnvelope> = {}): ReportableEnvelope => ({
  id: '$evt-bad',
  roomId: '!room:noodles',
  sender: '@carol:noodles',
  originTs: NOW - 60_000,
  preview: { kind: 'text', text: 'the offending message' },
  expiresAt: null,
  ...over,
});

const draft = (over: Partial<ReportDraft> = {}): ReportDraft => ({
  subjectId: '$evt-bad',
  categoryId: 'harassment',
  note: '',
  anonymous: false,
  ...over,
});

const evidence = (over: Partial<Evidence> = {}): Evidence => ({
  capturedAt: NOW,
  senderAtCapture: '@carol:noodles',
  originTs: NOW - 60_000,
  contentSnapshot: 'the offending message',
  subjectExpiresAt: null,
  ...over,
});

const moderators = { '@mod:noodles': ['DEV1', 'DEV2'] };

const wireOf = (content: Record<string, unknown>, over: Partial<WireEvent> = {}): WireEvent => ({
  eventId: '$report-1',
  txnId: 'report-1',
  senderUserId: '@bob:noodles',
  eventType: REPORT_EVENT_TYPE,
  content,
  createdAt: '2026-08-04T12:00:00.000Z',
  revoked: false,
  ...over,
});

describe('the only available channel', () => {
  it('packs as an Olm to-device event, not a room event', () => {
    // A room event would be readable by everyone in the room, including the
    // person being reported. There is no report endpoint, so this is what is left.
    const out = packReport({ reportId: 'r1', draft: draft(), subject: subject(), reporter: '@bob:noodles', moderatorDevices: moderators, seed: 1 });

    expect(out.eventType).toBe(TO_DEVICE_EVENT_TYPE);
    expect(out.eventType).toBe('m.room.encrypted');
    expect(out.plaintext.eventType).toBe('app.report.submit');
  });

  it('produces one ciphertext per moderator device', () => {
    // Olm is per-device. A moderator with three devices is three encryptions, and
    // a moderator who has just reinstalled may have none of the old ones.
    const out = packReport({
      reportId: 'r1',
      draft: draft(),
      subject: subject(),
      reporter: '@bob:noodles',
      moderatorDevices: { '@mod:noodles': ['A', 'B'], '@mod2:noodles': ['C'] },
      seed: 2,
    });

    expect(out.deviceCount).toBe(3);
    expect(isDeliverable(out)).toBe(true);
  });

  it('is undeliverable when no moderator has a device', () => {
    // The submit button must not claim success here.
    const out = packReport({
      reportId: 'r1',
      draft: draft(),
      subject: subject(),
      reporter: '@bob:noodles',
      moderatorDevices: { '@mod:noodles': [] },
      seed: 3,
    });

    expect(out.deviceCount).toBe(0);
    expect(isDeliverable(out)).toBe(false);
    expect(out.targets).toEqual({});
  });

  it('deduplicates device ids', () => {
    const out = packReport({
      reportId: 'r1',
      draft: draft(),
      subject: subject(),
      reporter: '@bob:noodles',
      moderatorDevices: { '@mod:noodles': ['A', 'A', 'B'] },
      seed: 4,
    });
    expect(out.deviceCount).toBe(2);
  });

  it('carries a txnId, because a to-device message is revocable too', () => {
    const out = packReport({ reportId: 'r1', draft: draft(), subject: subject(), reporter: '@bob:noodles', moderatorDevices: moderators, seed: 'x' });
    expect(out.txnId).toBe('report-x');
  });
});

describe('anonymity, honestly', () => {
  it('omits the reporter when the report is anonymous', () => {
    const out = packReport({
      reportId: 'r1',
      draft: draft({ anonymous: true }),
      subject: subject(),
      reporter: '@bob:noodles',
      moderatorDevices: moderators,
      seed: 5,
    });

    expect('app.report.reporter' in out.plaintext.content).toBe(false);
    expect(out.plaintext.content['app.report.anonymous']).toBe(true);
  });

  it('includes the reporter when it is not', () => {
    const out = packReport({ reportId: 'r1', draft: draft(), subject: subject(), reporter: '@bob:noodles', moderatorDevices: moderators, seed: 6 });
    expect(out.plaintext.content['app.report.reporter']).toBe('@bob:noodles');
  });

  // Not a code assertion — a note the type system cannot make. Anonymity here is
  // from the moderator only: the Olm session identifies the sending device
  // regardless of what the content omits. The UI must not promise more.
});

describe('whether the report will be actionable', () => {
  it('is actionable for live content with evidence permitted', () => {
    const result = reportability(subject(), { nowMs: NOW, evidencePermitted: true });
    expect(result.actionable).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('is a bare pointer when the room forbids a content copy', () => {
    // The moderator is not in the room and holds no room key, so a pointer
    // resolves to nothing for them.
    const result = reportability(subject(), { nowMs: NOW, evidencePermitted: false });
    expect(result.actionable).toBe(false);
    expect(result.reasons).toContain('no_evidence_permitted');
  });

  it('reports a revoked subject distinctly from an expired one', () => {
    const revoked = reportability(subject({ redactedAt: NOW - 1000 }), { nowMs: NOW, evidencePermitted: false });
    expect(revoked.reasons).toContain('subject_revoked');
    expect(revoked.reasons).not.toContain('subject_expired');

    const expired = reportability(subject({ expiresAt: NOW - 1 }), { nowMs: NOW, evidencePermitted: false });
    expect(expired.reasons).toContain('subject_expired');
    expect(expired.reasons).not.toContain('subject_revoked');
  });

  it('is still actionable for a revoked subject when evidence was captured', () => {
    // This is exactly what the evidence copy is for — and exactly why it is a
    // privacy cost rather than a free win.
    const result = reportability(subject({ redactedAt: NOW - 1000 }), { nowMs: NOW, evidencePermitted: true });
    expect(result.actionable).toBe(true);
    expect(result.reasons).toContain('subject_revoked');
  });

  it('flags view-once media as unknowable rather than as a failure', () => {
    // Only the server knows whether the single view has been spent.
    const result = reportability(subject(), { nowMs: NOW, evidencePermitted: true, subjectIsViewOnce: true });
    expect(result.reasons).toContain('subject_may_be_view_once');
    expect(result.actionable).toBe(true);
  });

  it('reports every reason at once', () => {
    const result = reportability(subject({ redactedAt: NOW, expiresAt: NOW - 1 }), {
      nowMs: NOW,
      evidencePermitted: false,
    });
    expect(result.reasons).toHaveLength(3);
  });
});

describe('evidence', () => {
  it('transmits only the enumerated fields', () => {
    // Enumerated rather than spread, so a new field on Evidence does not start
    // leaving the device without anyone deciding it should.
    const out = packReport({
      reportId: 'r1',
      draft: draft(),
      subject: subject(),
      evidence: evidence(),
      reporter: '@bob:noodles',
      moderatorDevices: moderators,
      seed: 7,
    });
    const wire = out.plaintext.content['app.report.evidence'] as Record<string, unknown>;

    expect(Object.keys(wire).sort()).toEqual([
      'captured_at',
      'content_snapshot',
      'origin_ts',
      'sender_at_capture',
      'subject_expires_at',
    ]);
  });

  it('carries the subject’s expiry so a moderator knows what they are holding', () => {
    const out = packReport({
      reportId: 'r1',
      draft: draft(),
      subject: subject(),
      evidence: evidence({ subjectExpiresAt: NOW + 60_000 }),
      reporter: '@bob:noodles',
      moderatorDevices: moderators,
      seed: 8,
    });
    const wire = out.plaintext.content['app.report.evidence'] as Record<string, unknown>;
    expect(wire['subject_expires_at']).toBe(NOW + 60_000);
  });

  it('is absent entirely when not captured', () => {
    const out = packReport({ reportId: 'r1', draft: draft(), subject: subject(), reporter: '@bob:noodles', moderatorDevices: moderators, seed: 9 });
    expect('app.report.evidence' in out.plaintext.content).toBe(false);
  });
});

describe('receiving a report, as a moderator', () => {
  it('round-trips a report with evidence', () => {
    const out = packReport({
      reportId: 'r1',
      draft: draft({ note: '  please look  ' }),
      subject: subject(),
      evidence: evidence(),
      reporter: '@bob:noodles',
      moderatorDevices: moderators,
      seed: 10,
    });
    const decoded = unpackReport(wireOf(out.plaintext.content));

    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.reportId).toBe('r1');
    expect(decoded.value.note).toBe('please look');
    expect(decoded.value.reporter).toBe('@bob:noodles');
    expect(decoded.value.subject.eventId).toBe('$evt-bad');
    expect(decoded.value.evidence?.contentSnapshot).toBe('the offending message');
    expect(canModeratorAct(decoded.value).can).toBe(true);
  });

  it('leaves the reporter null for an anonymous report', () => {
    const out = packReport({
      reportId: 'r1',
      draft: draft({ anonymous: true }),
      subject: subject(),
      evidence: evidence(),
      reporter: '@bob:noodles',
      moderatorDevices: moderators,
      seed: 11,
    });
    const decoded = unpackReport(wireOf(out.plaintext.content));
    if (decoded.ok) expect(decoded.value.reporter).toBeNull();
  });

  it('says plainly that a pointer-only report cannot be acted on', () => {
    const out = packReport({ reportId: 'r1', draft: draft(), subject: subject(), reporter: '@bob:noodles', moderatorDevices: moderators, seed: 12 });
    const decoded = unpackReport(wireOf(out.plaintext.content));

    if (!decoded.ok) throw new Error('expected ok');
    expect(decoded.value.evidence).toBeNull();
    const verdict = canModeratorAct(decoded.value);
    expect(verdict.can).toBe(false);
    expect(verdict.why).toContain('not in the room');
  });

  it('catches an evidence copy that arrived empty', () => {
    const out = packReport({
      reportId: 'r1',
      draft: draft(),
      subject: subject(),
      evidence: evidence({ contentSnapshot: '   ' }),
      reporter: '@bob:noodles',
      moderatorDevices: moderators,
      seed: 13,
    });
    const decoded = unpackReport(wireOf(out.plaintext.content));
    if (decoded.ok) expect(canModeratorAct(decoded.value).can).toBe(false);
  });

  it('refuses a revoked report event before reading it', () => {
    const out = packReport({ reportId: 'r1', draft: draft(), subject: subject(), reporter: '@bob:noodles', moderatorDevices: moderators, seed: 14 });
    const decoded = unpackReport(wireOf(out.plaintext.content, { revoked: true }));

    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('revoked');
  });

  it('rejects a report missing its subject', () => {
    expect(unpackReport(wireOf({ 'app.report.id': 'r1' })).ok).toBe(false);
    expect(unpackReport(wireOf({ 'app.report.subject': { event_id: '$x' } })).ok).toBe(false);
  });

  it('treats a non-report inner type as unknown, not malformed', () => {
    const decoded = unpackReport(wireOf({ msgtype: 'm.text', body: 'hi' }, { eventType: 'm.room.message' }));
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) expect(decoded.reason).toBe('unknown_type');
  });
});
