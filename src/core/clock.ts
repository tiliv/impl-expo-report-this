/**
 * Time is an input, not an ambient fact.
 *
 * Expiry is the whole point of this template, and expiry is unobservable if
 * `Date.now()` is buried inside the render path. Every function that cares
 * about "now" takes it as an argument; the app gets it from a `Clock`.
 *
 * In the experiment the clock is manual, so you can push time forward a day
 * and watch a quote decay. In the real app you pass `systemClock`. Nothing
 * downstream changes.
 */

export interface Clock {
  now(): number;
  subscribe(listener: () => void): () => void;
}

export const systemClock = (tickMs = 1000): Clock => {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    now: () => Date.now(),
    subscribe(listener) {
      listeners.add(listener);
      if (timer === null) timer = setInterval(() => listeners.forEach((l) => l()), tickMs);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
};

export class ManualClock implements Clock {
  private current: number;
  private listeners = new Set<() => void>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(start: number) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Jump forward. The whole tree re-resolves against the new now. */
  advance(ms: number): void {
    this.current += ms;
    this.emit();
  }

  set(ts: number): void {
    this.current = ts;
    this.emit();
  }

  /** Let the manual clock run in real time, so decay is watchable live. */
  play(intervalMs = 1000, scale = 1): void {
    this.pause();
    this.timer = setInterval(() => this.advance(intervalMs * scale), intervalMs);
  }

  pause(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function formatDuration(ms: number): string {
  if (ms <= 0) return '0s';
  const d = Math.floor(ms / DAY);
  const h = Math.floor((ms % DAY) / HOUR);
  const m = Math.floor((ms % HOUR) / MINUTE);
  const s = Math.floor((ms % MINUTE) / SECOND);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
