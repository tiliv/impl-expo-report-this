/**
 * Room state -> reporting policy.
 *
 * The interesting one in this template is `categories`. The list of things you
 * can report someone for is *room-defined* — a support room and a public
 * broadcast room do not want the same taxonomy — which means the picker is
 * populated from a state event that a room admin controls, and which may be
 * malformed, empty, or enormous.
 *
 * A room must not be able to break reporting by writing a bad category list.
 * Bad entries are dropped individually with a warning; a list with nothing
 * usable in it falls back to the built-in taxonomy rather than leaving the user
 * with no way to report anything.
 */

import type { RoomStateStore } from './roomState';
import type { ReportCategory, ReportDestination, UserId } from './types';

export const STATE_REPORT = 'app.envelope.report';
export const STATE_RETENTION = 'm.room.retention';

export type SettingSource =
  | { kind: 'default' }
  | { kind: 'state_event'; type: string; eventId: string; sender: UserId; originTs: number };

export interface Resolved<T> {
  value: T;
  source: SettingSource;
}

/** What happens to the reported message locally, for the reporter. */
export type HideBehavior =
  /** Nothing. The message stays exactly where it was. */
  | 'never'
  /** Hidden for this user immediately, reversible. */
  | 'local'
  /** Hidden for this user until a moderator resolves the report. */
  | 'until_reviewed';

export interface ReportSettings {
  categories: Resolved<ReportCategory[]>;
  destination: Resolved<ReportDestination>;
  allowAnonymous: Resolved<boolean>;
  /** Snapshot the content into the report. See the note in `types.ts`. */
  includeContentCopy: Resolved<boolean>;
  cooldownMs: Resolved<number>;
  allowSelfReport: Resolved<boolean>;
  hideOnReport: Resolved<HideBehavior>;
  maxNoteChars: Resolved<number>;
  /** Retention on the room, so a report can tell you the subject will vanish. */
  retentionMaxLifetimeMs: Resolved<number | null>;
}

export interface SettingsWarning {
  setting: keyof ReportSettings;
  severity: 'info' | 'warn' | 'danger';
  message: string;
}

export interface ResolvedReportSettings {
  settings: ReportSettings;
  warnings: SettingsWarning[];
}

/**
 * The fallback taxonomy. Used when a room says nothing, and when a room says
 * something unusable — a user with no way to report anything is a worse
 * outcome than a user with the wrong category list.
 */
export const DEFAULT_CATEGORIES: ReportCategory[] = [
  { id: 'spam', label: 'Spam or scam', requiresNote: false, severity: 'low' },
  {
    id: 'harassment',
    label: 'Harassment',
    description: 'Targeted abuse, threats, or repeated unwanted contact',
    requiresNote: false,
    severity: 'high',
  },
  { id: 'csam', label: 'Child safety', requiresNote: false, severity: 'high' },
  { id: 'illegal', label: 'Illegal content', requiresNote: true, severity: 'high' },
  { id: 'other', label: 'Something else', requiresNote: true, severity: 'medium' },
];

const DEFAULTS = {
  destination: 'room_moderators' as ReportDestination,
  allowAnonymous: true,
  includeContentCopy: true,
  cooldownMs: 60_000,
  allowSelfReport: false,
  hideOnReport: 'local' as HideBehavior,
  maxNoteChars: 1000,
  retentionMaxLifetimeMs: null as number | null,
};

const DESTINATIONS: ReportDestination[] = ['room_moderators', 'homeserver', 'external_service'];
const HIDE: HideBehavior[] = ['never', 'local', 'until_reviewed'];
const SEVERITIES = ['low', 'medium', 'high'] as const;

export const DEFAULT_SOURCE: SettingSource = { kind: 'default' };

/** Parses one category entry, or returns why it is unusable. */
function parseCategory(raw: unknown, index: number): { ok: ReportCategory } | { error: string } {
  if (typeof raw !== 'object' || raw === null) return { error: `categories[${index}] is not an object` };
  const entry = raw as Record<string, unknown>;
  const id = entry.id;
  const label = entry.label;
  if (typeof id !== 'string' || id.length === 0) return { error: `categories[${index}] has no usable id` };
  if (typeof label !== 'string' || label.length === 0) {
    return { error: `categories[${index}] (${id}) has no usable label` };
  }
  const severity = SEVERITIES.includes(entry.severity as (typeof SEVERITIES)[number])
    ? (entry.severity as ReportCategory['severity'])
    : 'medium';
  return {
    ok: {
      id,
      label: label.slice(0, 60),
      description: typeof entry.description === 'string' ? entry.description.slice(0, 160) : undefined,
      requiresNote: entry.requires_note === true,
      severity,
    },
  };
}

export function resolveReportSettings(store: RoomStateStore): ResolvedReportSettings {
  const warnings: SettingsWarning[] = [];
  const reportEvent = store.get(STATE_REPORT);
  const retentionEvent = store.get(STATE_RETENTION);

  const sourceOf = (e: typeof reportEvent): SettingSource =>
    e
      ? { kind: 'state_event', type: e.type, eventId: e.eventId, sender: e.sender, originTs: e.originTs }
      : DEFAULT_SOURCE;

  function read<T>(
    setting: keyof ReportSettings,
    event: typeof reportEvent,
    field: string,
    fallback: T,
    validate: (raw: unknown) => T | null,
  ): Resolved<T> {
    if (!event || !(field in event.content)) return { value: fallback, source: DEFAULT_SOURCE };
    const raw = event.content[field];
    if (raw === null || raw === undefined) return { value: fallback, source: DEFAULT_SOURCE };
    const ok = validate(raw);
    if (ok === null) {
      warnings.push({
        setting,
        severity: 'warn',
        message: `${event.type}.${field} = ${JSON.stringify(raw)} is not usable; using default`,
      });
      return { value: fallback, source: DEFAULT_SOURCE };
    }
    return { value: ok, source: sourceOf(event) };
  }

  // --- categories, which get their own treatment ---------------------------

  let categories: Resolved<ReportCategory[]> = {
    value: DEFAULT_CATEGORIES,
    source: DEFAULT_SOURCE,
  };

  const rawCategories = reportEvent?.content.categories;
  if (Array.isArray(rawCategories)) {
    const parsed: ReportCategory[] = [];
    const seen = new Set<string>();
    rawCategories.slice(0, 24).forEach((raw, index) => {
      const result = parseCategory(raw, index);
      if ('error' in result) {
        warnings.push({ setting: 'categories', severity: 'warn', message: `${result.error}; dropped` });
        return;
      }
      if (seen.has(result.ok.id)) {
        warnings.push({
          setting: 'categories',
          severity: 'info',
          message: `duplicate category id "${result.ok.id}"; keeping the first`,
        });
        return;
      }
      seen.add(result.ok.id);
      parsed.push(result.ok);
    });

    if (parsed.length === 0) {
      warnings.push({
        setting: 'categories',
        severity: 'danger',
        message: 'Room defined a category list with nothing usable in it; falling back to defaults',
      });
    } else {
      categories = { value: parsed, source: sourceOf(reportEvent) };
      if (rawCategories.length > 24) {
        warnings.push({
          setting: 'categories',
          severity: 'info',
          message: `Room defined ${rawCategories.length} categories; only the first 24 are offered`,
        });
      }
    }
  } else if (rawCategories !== undefined) {
    warnings.push({
      setting: 'categories',
      severity: 'warn',
      message: 'categories is not an array; using defaults',
    });
  }

  const int = (min: number, max: number) => (raw: unknown): number | null =>
    typeof raw === 'number' && Number.isFinite(raw) ? Math.min(max, Math.max(min, Math.round(raw))) : null;
  const bool = (raw: unknown): boolean | null => (typeof raw === 'boolean' ? raw : null);
  const oneOf = <T extends string>(allowed: T[]) => (raw: unknown): T | null =>
    allowed.includes(raw as T) ? (raw as T) : null;

  const settings: ReportSettings = {
    categories,
    destination: read('destination', reportEvent, 'destination', DEFAULTS.destination, oneOf(DESTINATIONS)),
    allowAnonymous: read('allowAnonymous', reportEvent, 'allow_anonymous', DEFAULTS.allowAnonymous, bool),
    includeContentCopy: read(
      'includeContentCopy',
      reportEvent,
      'include_content_copy',
      DEFAULTS.includeContentCopy,
      bool,
    ),
    cooldownMs: read('cooldownMs', reportEvent, 'cooldown_ms', DEFAULTS.cooldownMs, int(0, 24 * 3600_000)),
    allowSelfReport: read('allowSelfReport', reportEvent, 'allow_self_report', DEFAULTS.allowSelfReport, bool),
    hideOnReport: read('hideOnReport', reportEvent, 'hide_on_report', DEFAULTS.hideOnReport, oneOf(HIDE)),
    maxNoteChars: read('maxNoteChars', reportEvent, 'max_note_chars', DEFAULTS.maxNoteChars, int(80, 4000)),
    retentionMaxLifetimeMs: read<number | null>(
      'retentionMaxLifetimeMs',
      retentionEvent,
      'max_lifetime',
      DEFAULTS.retentionMaxLifetimeMs,
      (raw) =>
        typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? Math.round(raw) * 1000 : null,
    ),
  };

  // The combination worth shouting about: content that expires, and reports
  // that do not keep a copy of it. Neither setting is wrong alone.
  if (settings.retentionMaxLifetimeMs.value !== null && !settings.includeContentCopy.value) {
    warnings.push({
      setting: 'includeContentCopy',
      severity: 'danger',
      message:
        'This room expires content and reports carry no copy of it. ' +
        'Moderators will receive pointers to messages that no longer exist.',
    });
  }

  if (settings.destination.value === 'external_service' && settings.includeContentCopy.value) {
    warnings.push({
      setting: 'destination',
      severity: 'warn',
      message: 'Reports leave the homeserver carrying a copy of the reported content.',
    });
  }

  return { settings, warnings };
}

export function describeSource(source: SettingSource): string {
  return source.kind === 'default' ? 'default' : `${source.type} by ${source.sender}`;
}
