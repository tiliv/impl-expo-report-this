/**
 * Room state, as room state.
 *
 * The experiment does not hand the feature a settings object. It writes state
 * events into a store, exactly like a sync response would, and the feature
 * reads whatever `resolveRoomSettings` makes of them. There is no branch
 * anywhere that says "if experiment, use fake settings" — the control panel
 * is a *sender of state events*, not a bypass.
 *
 * That is the point: when you later swap this store for one fed by your real
 * sync loop, the resolution path underneath is code that has already run.
 */

import type { EventId, UserId } from './types';

export interface StateEvent<C = Record<string, unknown>> {
  eventId: EventId;
  type: string;
  /** Matrix state key. Empty string for room-wide config, which is our case. */
  stateKey: string;
  sender: UserId;
  originTs: number;
  content: C;
}

const key = (type: string, stateKey: string) => `${type}|${stateKey}`;

export class RoomStateStore {
  private events = new Map<string, StateEvent>();
  private listeners = new Set<() => void>();

  /** Apply a state event. Later `originTs` for the same key wins, as in Matrix. */
  send(event: StateEvent): void {
    const k = key(event.type, event.stateKey);
    const existing = this.events.get(k);
    if (existing && existing.originTs > event.originTs) return;
    this.events.set(k, event);
    this.emit();
  }

  /** Remove a state event entirely, so the resolver falls back to its default. */
  clear(type: string, stateKey = ''): void {
    if (this.events.delete(key(type, stateKey))) this.emit();
  }

  reset(events: StateEvent[] = []): void {
    this.events.clear();
    for (const e of events) this.events.set(key(e.type, e.stateKey), e);
    this.emit();
  }

  get<C = Record<string, unknown>>(type: string, stateKey = ''): StateEvent<C> | undefined {
    return this.events.get(key(type, stateKey)) as StateEvent<C> | undefined;
  }

  all(): StateEvent[] {
    return [...this.events.values()].sort((a, b) => a.type.localeCompare(b.type));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

let stateEventSeq = 0;

/** Convenience for scenarios and for the control panel's "send" buttons. */
export function stateEvent<C extends Record<string, unknown>>(
  type: string,
  content: C,
  opts: { sender?: UserId; originTs?: number; stateKey?: string } = {},
): StateEvent<C> {
  return {
    eventId: `$state-${++stateEventSeq}`,
    type,
    stateKey: opts.stateKey ?? '',
    sender: opts.sender ?? '@admin:example.org',
    originTs: opts.originTs ?? stateEventSeq,
    content,
  };
}
