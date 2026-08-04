/**
 * Scenarios: arrange a room and a message, state what should happen, then try
 * to report it.
 *
 * The interesting ones are not the happy path. They are the arrangements where
 * the room's own policies fight each other — content that expires and reports
 * that carry no copy of it, category lists that arrive malformed, a cooldown
 * that lands on someone reporting a burst of abuse from one account.
 */

import { MINUTE, HOUR } from '../core/clock';
import { stateEvent } from '../core/roomState';
import { STATE_REPORT, STATE_RETENTION } from '../core/settings';
import { envelope, EPOCH, type ExperimentWorld } from './world';

export interface Scenario {
  id: string;
  title: string;
  question: string;
  group: 'basics' | 'evidence' | 'limits' | 'transport';
  arrange(world: ExperimentWorld): void;
  expect: string[];
  tryNext?: string[];
}

const ABUSER = '@stranger:example.org';
const YOU = '@you:example.org';

const reportConfig = (content: Record<string, unknown>) =>
  stateEvent(STATE_REPORT, content, { sender: '@admin:example.org' });

const retention = (seconds: number) =>
  stateEvent(STATE_RETENTION, { max_lifetime: seconds }, { sender: '@admin:example.org' });

export const SCENARIOS: Scenario[] = [
  {
    id: 'baseline',
    title: 'Ordinary report',
    group: 'basics',
    question: 'What does the plain path look like?',
    arrange(w) {
      w.add(
        envelope({
          sender: ABUSER,
          originTs: EPOCH - 3 * MINUTE,
          text: 'Buy followers cheap, click here → bit.ly/notascam',
        }),
      );
    },
    expect: [
      'Five built-in categories, because the room has defined none.',
      '"Something else" and "Illegal content" require a note; the others do not.',
      'After sending, the message is hidden locally — hide_on_report defaults to local.',
    ],
  },

  {
    id: 'room-categories',
    title: 'Room defines its own taxonomy',
    group: 'basics',
    question: 'Who decides what you can report someone for?',
    arrange(w) {
      w.stateStore.send(
        reportConfig({
          categories: [
            { id: 'off_topic', label: 'Off topic', severity: 'low' },
            {
              id: 'unsourced',
              label: 'Unsourced claim',
              description: 'Asserted as fact with no citation',
              requires_note: true,
              severity: 'medium',
            },
            { id: 'doxxing', label: 'Personal information', severity: 'high' },
          ],
        }),
      );
      w.add(envelope({ sender: ABUSER, originTs: EPOCH - 8 * MINUTE, text: 'Everyone knows the numbers are fabricated.' }));
    },
    expect: [
      'The picker shows the room\'s three categories, not the built-in five.',
      'A support room and a broadcast room want different taxonomies; this is why the list is room state.',
      'Provenance under the picker names the state event and who sent it.',
    ],
  },

  {
    id: 'expiring-no-evidence',
    title: 'Expiring content, reports carry no copy',
    group: 'evidence',
    question: 'Can you report something that will be gone before anyone reads the report?',
    arrange(w) {
      w.stateStore.send(retention(10 * 60));
      w.stateStore.send(reportConfig({ include_content_copy: false }));
      w.add(
        envelope({
          sender: ABUSER,
          originTs: EPOCH - 6 * MINUTE,
          text: 'If you tell anyone I will find out where you live.',
          expiresAt: EPOCH + 4 * MINUTE,
        }),
      );
    },
    expect: [
      'A danger-level warning fires at resolve time, before you open the sheet.',
      'The sheet adds a notice: this expires in ~4m and the report will not include a copy.',
      'The notice does not block sending. It is information, not an objection.',
      'This is the tension the template exists to surface: retention and evidence want opposite things.',
    ],
    tryNext: [
      'Turn include_content_copy on and watch the warning invert into a privacy one.',
      'Advance the clock past expiry and report it anyway.',
    ],
  },

  {
    id: 'evidence-leaves-server',
    title: 'Evidence sent to an external service',
    group: 'evidence',
    question: 'What is the cost of keeping a copy?',
    arrange(w) {
      w.stateStore.send(retention(60 * 60));
      w.stateStore.send(reportConfig({ include_content_copy: true, destination: 'external_service' }));
      w.add(
        envelope({
          sender: ABUSER,
          originTs: EPOCH - 20 * MINUTE,
          text: 'Photo of the whiteboard from the closed session.',
          expiresAt: EPOCH + 40 * MINUTE,
        }),
      );
    },
    expect: [
      'A warning says reports leave the homeserver carrying the content.',
      'The report preview shows exactly what would be captured, before you send it.',
      'Neither setting is wrong on its own; the combination is the thing to decide about.',
    ],
  },

  {
    id: 'already-redacted',
    title: 'Reporting something already deleted',
    group: 'evidence',
    question: 'Is there any point reporting content that is gone?',
    arrange(w) {
      w.stateStore.send(reportConfig({ include_content_copy: true }));
      w.add(
        envelope({
          sender: ABUSER,
          originTs: EPOCH - 30 * MINUTE,
          text: '(removed)',
          redactedAt: EPOCH - 2 * MINUTE,
        }),
      );
    },
    expect: [
      'Reporting is still allowed: the pattern of behaviour matters even when the message is gone.',
      'A notice says what the report can and cannot carry.',
      'With include_content_copy off, the notice is blunter — moderators may see nothing at all.',
    ],
  },

  {
    id: 'cooldown',
    title: 'Cooldown during a burst of abuse',
    group: 'limits',
    question: 'Does rate limiting protect the room or punish the victim?',
    arrange(w) {
      w.stateStore.send(reportConfig({ cooldown_ms: 5 * 60_000 }));
      w.seedHistory({
        id: 'prior',
        subjectId: '$earlier',
        categoryId: 'harassment',
        reporter: YOU,
        createdAt: EPOCH - 60_000,
      });
      w.add(
        envelope({ sender: ABUSER, originTs: EPOCH - 90_000, text: 'first one' }),
        envelope({ sender: ABUSER, originTs: EPOCH - 40_000, text: 'second one' }),
        envelope({ sender: ABUSER, originTs: EPOCH - 10_000, text: 'third one' }),
      );
    },
    expect: [
      'Reporting is blocked for four more minutes, with the remaining time named.',
      'One person sending three abusive messages produces three things worth reporting.',
      'A five-minute cooldown is defensible against report spam and hostile to the person being targeted.',
      'Advance the clock past the window and it unblocks.',
    ],
    tryNext: ['Decide whether cooldown should be per-sender rather than global. It currently is not.'],
  },

  {
    id: 'duplicate',
    title: 'Reporting the same thing twice',
    group: 'limits',
    question: 'Is a second report on the same message useful?',
    arrange(w) {
      w.stateStore.send(reportConfig({ cooldown_ms: 0 }));
      const target = envelope({ sender: ABUSER, originTs: EPOCH - 5 * MINUTE, text: 'the same offending message' });
      w.add(target);
      w.seedHistory({
        id: 'prior',
        subjectId: target.id,
        categoryId: 'spam',
        reporter: YOU,
        createdAt: EPOCH - 2 * MINUTE,
      });
    },
    expect: [
      'Reporting it again for spam is blocked as a duplicate.',
      'Reporting it for harassment instead is allowed — a different claim about the same message.',
      'Duplicate is checked before cooldown so the message names the real reason.',
    ],
  },

  {
    id: 'self-report',
    title: 'Reporting your own message',
    group: 'limits',
    question: 'Should you be able to?',
    arrange(w) {
      w.add(envelope({ sender: YOU, originTs: EPOCH - 4 * MINUTE, text: 'something I posted and regret' }));
    },
    expect: [
      'Blocked by default.',
      'Turn allow_self_report on and it works — some rooms use it as a "please remove this" path.',
    ],
  },

  {
    id: 'hostile-categories',
    title: 'Room sends a broken category list',
    group: 'limits',
    question: 'Can a room admin break reporting?',
    arrange(w) {
      w.stateStore.send(
        reportConfig({
          categories: [
            { id: 'ok', label: 'A real one', severity: 'low' },
            { label: 'no id at all' },
            'not even an object',
            { id: 'ok', label: 'Duplicate id' },
            { id: 'nolabel' },
          ],
        }),
      );
      w.add(envelope({ sender: ABUSER, originTs: EPOCH - 3 * MINUTE, text: 'anything' }));
    },
    expect: [
      'One usable category survives; the rest are dropped individually with warnings.',
      'Reporting still works. A room must not be able to disable it by writing bad state.',
      'Send a list with nothing usable and it falls back to the built-in five — no way to report is worse than the wrong list.',
    ],
  },

  {
    id: 'offline',
    title: 'Offline while reporting',
    group: 'transport',
    question: 'What happens to a report that cannot be sent?',
    arrange(w) {
      w.setNetwork('offline');
      w.add(envelope({ sender: ABUSER, originTs: EPOCH - 2 * MINUTE, text: 'sent while you are on the train' }));
    },
    expect: [
      'The report is accepted locally and queued, not lost.',
      'The wording distinguishes accepted from delivered — "saved, not sent yet".',
      'It counts against cooldown immediately, because that is about how often you are filing, not about delivery.',
      'Hit retry with the network back on and it goes.',
    ],
  },

  {
    id: 'rejected',
    title: 'Destination refuses the report',
    group: 'transport',
    question: 'Which failures are worth retrying?',
    arrange(w) {
      w.setNetwork('rejects');
      w.add(envelope({ sender: ABUSER, originTs: EPOCH - 2 * MINUTE, text: 'anything' }));
    },
    expect: [
      'A rejection is terminal: no queue, no backoff, the reason is shown as given.',
      'Server errors and rate limits queue with exponential backoff instead.',
      'A manual retry after giving up resets the attempt count — the user asking again is new information.',
    ],
    tryNext: ['Switch to rate_limited and watch it honour the server\'s retry-after instead of the backoff curve.'],
  },
];

export const DEFAULT_SCENARIO = SCENARIOS[0];

export function loadScenario(world: ExperimentWorld, scenario: Scenario): void {
  world.reset();
  scenario.arrange(world);
}

export { HOUR, MINUTE };
