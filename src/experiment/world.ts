/**
 * The experiment's stand-in for a room you can report things in.
 *
 * The simulated network is the part worth keeping honest: the submission
 * machine's whole reason to exist is the failure cases, so the panel can put
 * the transport into offline / server error / rate limited / rejected and let
 * you watch the queue behave.
 */

import { ManualClock } from '../core/clock';
import { RoomStateStore } from '../core/roomState';
import { resolveReportSettings } from '../core/settings';
import { submissionReducer, type SubmissionAction, type SubmissionFailure, type SubmissionState } from '../core/submission';
import type { EventId, Report, ReportRecord, ReportableEnvelope } from '../core/types';

export const EPOCH = Date.UTC(2026, 0, 15, 12, 0, 0);

export type NetworkMode = 'online' | 'offline' | 'server_error' | 'rate_limited' | 'rejects';

export class ExperimentWorld {
  readonly stateStore = new RoomStateStore();
  readonly clock = new ManualClock(EPOCH);
  viewer = '@you:example.org';
  network: NetworkMode = 'online';

  private envelopeList: ReportableEnvelope[] = [];
  private historyList: ReportRecord[] = [];
  private submission: SubmissionState = { status: 'idle' };
  /** Locally hidden by `hide_on_report`. */
  private hidden = new Set<EventId>();
  private listeners = new Set<() => void>();
  private timers = new Set<ReturnType<typeof setTimeout>>();

  revision = 0;

  constructor() {
    this.stateStore.subscribe(() => this.emit());
    this.clock.subscribe(() => this.emit());
  }

  reset(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.envelopeList = [];
    this.historyList = [];
    this.hidden.clear();
    this.submission = { status: 'idle' };
    this.network = 'online';
    this.stateStore.reset([]);
    this.clock.pause();
    this.clock.set(EPOCH);
    this.emit();
  }

  add(...envelopes: ReportableEnvelope[]): this {
    this.envelopeList.push(...envelopes);
    this.emit();
    return this;
  }

  envelopes(): ReportableEnvelope[] {
    return this.envelopeList;
  }

  history(): ReportRecord[] {
    return this.historyList;
  }

  /** Pre-existing reports, so cooldown and duplicate rules have something to bite on. */
  seedHistory(...records: ReportRecord[]): this {
    this.historyList.push(...records);
    this.emit();
    return this;
  }

  isHidden(id: EventId): boolean {
    return this.hidden.has(id);
  }

  unhide(id: EventId): void {
    this.hidden.delete(id);
    this.emit();
  }

  setNetwork(mode: NetworkMode): void {
    this.network = mode;
    this.emit();
  }

  submissionState(): SubmissionState {
    return this.submission;
  }

  dispatch(action: SubmissionAction): void {
    this.submission = submissionReducer(this.submission, action);
    this.emit();
    if (this.submission.status === 'submitting') this.runTransport();
  }

  /**
   * Records the report locally the moment it is accepted, before the transport
   * has said anything. That is deliberate: cooldown and duplicate checks are
   * about how often *this user* is filing reports, which is true whether or
   * not the network has caught up.
   */
  accept(report: Report): void {
    this.historyList.push({
      id: report.id,
      subjectId: report.subject.id,
      categoryId: report.category.id,
      reporter: report.reporter,
      createdAt: report.createdAt,
    });
    const behavior = resolveReportSettings(this.stateStore).settings.hideOnReport.value;
    if (behavior !== 'never') this.hidden.add(report.subject.id);
    this.dispatch({ type: 'submit', report, at: this.clock.now() });
  }

  private runTransport(): void {
    const failure = this.failureForMode();
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      if (this.submission.status !== 'submitting') return;
      if (failure) this.dispatch({ type: 'failed', failure, at: this.clock.now() });
      else this.dispatch({ type: 'succeeded', at: this.clock.now() });
    }, 700);
    this.timers.add(timer);
  }

  private failureForMode(): SubmissionFailure | null {
    switch (this.network) {
      case 'online':
        return null;
      case 'offline':
        return { kind: 'offline' };
      case 'server_error':
        return { kind: 'server_error', status: 502 };
      case 'rate_limited':
        return { kind: 'rate_limited', retryAfterMs: 8_000 };
      case 'rejects':
        return { kind: 'rejected', reason: 'This room does not accept reports from new members.' };
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getRevision = (): number => this.revision;

  dispose(): void {
    this.timers.forEach(clearTimeout);
    this.timers.clear();
    this.clock.pause();
  }

  private emit(): void {
    this.revision += 1;
    this.listeners.forEach((l) => l());
  }
}

let envelopeSeq = 0;

export function envelope(
  partial: Partial<ReportableEnvelope> & Pick<ReportableEnvelope, 'sender'> & {
    text?: string;
    mediaSummary?: string;
  },
): ReportableEnvelope {
  envelopeSeq += 1;
  const { text, mediaSummary, ...rest } = partial;
  return {
    id: `$r${envelopeSeq}`,
    roomId: '!experiment:example.org',
    originTs: EPOCH,
    expiresAt: null,
    preview: mediaSummary ? { kind: 'media', mediaSummary } : { kind: 'text', text: text ?? '' },
    ...rest,
  };
}
