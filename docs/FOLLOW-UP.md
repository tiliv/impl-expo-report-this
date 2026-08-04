# Follow-up

Checked against the original intent: *reporting a message, targeted at a
specific message.*

## It already does that

`ReportDraft.subject` is a `ReportableEnvelope` — a single, identified event,
with its sender, its body preview and its lifecycle state. Reports are keyed to
that subject, duplicate detection is per subject, and `captureEvidence()`
snapshots that subject and nothing else. Targeting is not missing; the repo was
scoped from a one-line brief and guessed right.

Two smaller things are worth confirming on a device rather than assuming:

- **The affordance.** The sheet exists; whether it is reached by long-press on a
  message row, and how that interacts with the react-emoji long-press, is a
  `tabs-and-sheets` question rather than this repo's. Both sandboxes should
  assume one shared long-press menu, not two competing gestures.
- **Subject identity across expiry.** The subject is captured by event id. A
  report submitted moments before the subject expires still names an id the
  moderator can resolve; a report whose evidence copy was declined names an id
  that resolves to nothing. That is already the central tension here and it is
  handled — worth re-reading `include_content_copy` before anyone "simplifies"
  it.

## The one gap: reporting a person, not a message

The API has `/blocks` and `/blocks/{userId}` alongside everything else, so
blocking is a real, separate capability, and in every real product the two get
conflated: users reach for "report" when they mean "make this stop now".

That is a distinct flow with a distinct shape — no subject envelope, no
evidence question, immediate local effect, and a different reversibility story
(unblocking is normal; un-reporting is not). It would fit here as a second
subject kind:

```ts
type ReportSubject =
  | { kind: 'envelope'; envelope: ReportableEnvelope }
  | { kind: 'user'; userId: UserId; context?: EventId[] };
```

with `validateDraft` branching on it, and the report sheet offering "block them
as well" as a checkbox that performs a real, separate action.

**Not doing it yet.** It is additive, it does not disturb what is there, and
the message-reporting question this repo was built to answer is answered.
Recorded so the model does not get built in a way that forecloses it.

## Not changing

The refusal to pick between `include_content_copy: true` and `false`. Making
the combination visible at resolve time — retention on plus content copies off
raises a danger-level warning before anyone opens a sheet — is the right
posture and the pattern to copy elsewhere.
