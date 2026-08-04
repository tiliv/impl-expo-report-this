# impl-expo-report-this

A contained, runnable experiment for **reporting an envelope** — long-press,
pick a reason, send — in a room where the content being reported might not
survive long enough for a moderator to look at it.

Expo SDK 57, dev client.

```bash
npm install
npx expo run:ios      # or run:android — dev client, not Expo Go
npm test              # 36 tests, no device needed
npm run typecheck
```

> Scoped from a one-line brief — you named this repo but did not describe it,
> and this is the abuse/content-reporting flow that fits alongside the other
> three. If you meant something else by "report this", the room-settings
> harness and the scenario runner carry over; the domain model would not.

## The thing that makes this more than a form

Retention and evidence want opposite things.

A room that expires content does so on purpose. A report is a request for a
human to look at something later. Those two facts collide, and the collision is
the whole design problem:

- **`include_content_copy: false`** — the report is a pointer. It respects
  retention perfectly. A moderator opening it after the window sees nothing,
  and the person who reported harassment has no idea that happened.
- **`include_content_copy: true`** — the report carries a snapshot. Moderators
  can act. You have also just made a durable copy of exactly the content the
  room's retention policy exists to delete, and if `destination` is an external
  service, that copy has left the homeserver.

Neither is wrong. The template refuses to pick for you, and instead makes the
combination visible: setting retention *and* turning off content copies raises
a danger-level warning at resolve time, before anyone opens a report sheet.

`captureEvidence()` is the one place a snapshot is taken, and the sheet shows
the user exactly what it contains before they send.

## Errors vs notices

Validation returns a list, all at once. A report form that reveals its
objections one at a time is how you get someone who gives up half way through
reporting harassment.

The list is split by whether an issue *stops* the report:

| | Examples |
| --- | --- |
| **error** — blocks | no category, note required, self-report, duplicate, cooldown, unknown category |
| **notice** — informs | subject already deleted, subject expires in ~4m and no copy will be kept |

"This expires in four minutes and the report will not include a copy" is
information the user should have. It is not a reason to stop them.

`unknown_category` is not a theoretical case: a room can rewrite its category
list while a sheet is open.

## Categories come from the room

The list of things you can report someone for is room state. A support room and
a public broadcast room do not want the same taxonomy.

Which means a room admin can write a malformed list, and reporting must survive
it. Bad entries are dropped **individually** with a warning; a list with
nothing usable falls back to the built-in five. A user with the wrong category
list is a much better outcome than a user with no way to report anything.

## Accepted is not delivered

Submission is a state machine, not an awaited call, because the failure cases
are the point. Someone reporting harassment on a train is exactly the person
whose connection drops mid-submit.

```
submitting ──success──> submitted
     │
     ├── offline / server_error / rate_limited ──> queued ──retry──> submitting
     └── rejected  ──────────────────────────────> failed
```

- Retryable failures queue with exponential backoff; `rate_limited` honours the
  server's `retry-after` over the curve.
- A rejection is terminal — retrying a refusal just annoys the server.
- A **manual** retry after giving up resets the attempt count. The user asking
  again is new information.
- The wording is generated next to the machine so it cannot drift: a queued
  report is "saved, not sent yet", never "sent".

A report counts against the cooldown the moment it is *accepted locally*, not
when it is delivered. The cooldown is about how often this person is filing,
which is true whether or not the network has caught up.

## Room settings

| Type | Fields |
| --- | --- |
| `app.envelope.report` | `categories`, `destination`, `allow_anonymous`, `include_content_copy`, `cooldown_ms`, `allow_self_report`, `hide_on_report`, `max_note_chars` |
| `m.room.retention` | `max_lifetime` — read here so a report can tell you the subject is about to vanish |

Same discipline as the rest of the set: the panel only changes a setting by
sending the state event that carries it, resolved values carry provenance, and
hostile input clamps or falls back with a warning.

## Scenarios

Eleven arrangements across four groups. The ones worth loading first:

- **Expiring content, reports carry no copy** — the central tension, live.
- **Cooldown during a burst of abuse** — one person sending three abusive
  messages produces three things worth reporting, and a five-minute cooldown is
  simultaneously defensible against report spam and hostile to the person being
  targeted. The template does not resolve this; it makes you look at it.
- **Room sends a broken category list** — reporting survives.
- **Offline while reporting** — accepted, queued, honest about which.

## Layout

```
src/core/        pure TS — types, settings, validation, submission machine
src/adapters/    RoomStateSource, ReportTransport, ReportHistoryStore
src/ui/          the report sheet
src/experiment/  in-memory world, simulated transport, scenarios, panel
```

See [`docs/INTEGRATION.md`](docs/INTEGRATION.md).

## Known edges

- **Cooldown is global, not per-sender.** The burst scenario shows why that is
  the wrong shape; changing it is a change to `validateDraft` plus a
  `senderId` on `ReportRecord`.
- No moderator side. `until_reviewed` hides locally forever because nothing
  ever resolves a report.
- `hide_on_report` hides the subject for the reporter only. Room-wide hiding is
  a moderation action, not a reporting one.
- The transport is simulated with a 700ms timer. Real backoff scheduling — a
  timer that survives app restart and fires the queued retry — is not modelled.

---

## The wire boundary: there is nowhere to send a report

`src/core/envelope.ts` (byte-identical across the `impl-expo-*` repos) and
`src/core/packing.ts` connect this experiment to what the Noodles API actually
offers. The finding is what it does *not* offer.

`noodles-model/openapi/paths/` has **no report, moderation or abuse route**.
`messaging-lambda/src/main.rs` has no such handler. Reporting is not
unimplemented-but-designed — it is absent from the contract entirely. (This repo's
own `ReportDestination` union already lists `'homeserver'`; that is the option that
does not exist.)

That leaves three channels, two of them wrong:

| Channel | Verdict |
| --- | --- |
| A room event | Wrong — everyone in the room can read it, including the person being reported |
| A new endpoint | Doesn't exist; needs spec, lambda, storage and a moderator surface |
| **Olm to-device to a moderator's devices** | Available today. What `packReport` produces |

`ToDeviceEventType` restricts client-originated to-device events to
`m.room.encrypted` — exactly the Olm envelope — and `keys/query` has no contact
requirement, so a client can fetch a moderator's device keys without being their
contact. Olm is per-device, so one report to a moderator with three devices is
three ciphertexts, and `isDeliverable()` is false when they have none.

### The part that is not a packaging problem

E2EE means the server cannot read the reported content, so a report that is only a
*pointer* is unactionable — the moderator would need to have been in the room,
holding the room key, before the report arrived. **Moderating E2EE content requires
the reporter to hand over a copy encrypted to the moderator.**

That is a deliberate hole in the confidentiality guarantee, opened by the person
who was harmed. It cannot be closed by writing this code more carefully. What the
code can do is refuse to claim more than it delivers:

- `reportability()` — asked by the *reporter*, before sending. Returns every reason
  a report would arrive with nothing to look at: `subject_revoked`,
  `subject_expired`, `no_evidence_permitted`, `subject_may_be_view_once`.
- `canModeratorAct()` — asked on the *receiving* side. These two can disagree, and
  the disagreement is the interesting part: a report that was actionable when filed
  arrives without evidence if the room's policy changed in between.

**Anonymity is from the moderator, not from the server.** The Olm session
identifies the sending device whatever the content omits. Omitting the reporter
field is the honest maximum, and the UI must not promise more.

**Evidence is enumerated field by field, never spread.** It is the one type here
whose contents leave the device; a spread means the next field someone adds starts
being transmitted without anyone deciding it should.
