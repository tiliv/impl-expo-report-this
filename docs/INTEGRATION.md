# Wiring this into the real app

Integration should mean writing three adapters and deleting `src/experiment`.

## 1. Copy `src/core` and `src/adapters`

| File | What it owns |
| --- | --- |
| `types.ts` | `ReportableEnvelope`, `Report`, `Evidence` |
| `clock.ts` | Injected time, so cooldown and expiry are testable |
| `roomState.ts` | `RoomStateStore` |
| `settings.ts` | State events → policy, including the category taxonomy |
| `report.ts` | Validation, evidence capture, report construction |
| `submission.ts` | The delivery state machine and its wording |

## 2. Map your event to `ReportableEnvelope`

Two rules, both learned from the ways this goes wrong:

- **`preview` is what the user currently sees**, not the raw content. If your
  timeline shows a redaction tombstone, the report sheet must show the same
  thing — otherwise the user believes they are reporting something other than
  what they long-pressed.
- **`expiresAt` comes from the same retention calculation the timeline uses.**
  Two different expiry answers in one app surfaces as "it let me report it and
  then told me it was gone".

If you are also using the reply template, `expiryOf()` there is the function
this should agree with.

## 3. Implement `ReportHistoryStore` locally and durably

Not derived from the server. Cooldown and duplicate checks have to work
offline, and a queued report already counts.

It also has to survive the subject disappearing — keep records keyed by event
id after the event expires, or a user can re-report the same vanished message
indefinitely.

## 4. Implement `ReportTransport`

Return a failure, do not throw:

```ts
async send(report) {
  try {
    const res = await this.http.post(endpointFor(report.destination), serialize(report));
    if (res.ok) return { ok: true };
    if (res.status === 429) {
      return { ok: false, failure: { kind: 'rate_limited', retryAfterMs: retryAfter(res) } };
    }
    if (res.status >= 500) return { ok: false, failure: { kind: 'server_error', status: res.status } };
    return { ok: false, failure: { kind: 'rejected', reason: await reasonFrom(res) } };
  } catch {
    return { ok: false, failure: { kind: 'offline' } };
  }
}
```

The `offline` / `rejected` distinction decides whether the report is queued or
dropped, and that must not depend on parsing an exception message.

## 5. Schedule the retries for real

This is the piece the experiment does not model. `submissionReducer` computes
`nextAttemptAt`; something has to still be there when it arrives.

The queue needs to be persisted and drained on launch and on connectivity
change — an in-memory timer dies with the process, and the whole reason the
queue exists is the user whose app got killed on a train.

## 6. Serialising a report

Decide deliberately, because this is where the privacy cost lands:

- With `evidence`, the payload contains a copy of content the room may be
  configured to delete. Store it wherever your retention policy for *reports*
  says, which is probably not where the room's policy says.
- Without `evidence`, include enough to find the event later — room id, event
  id, origin timestamp, sender — and accept that resolution may fail.
- `reporter: null` means anonymous. Make sure it is anonymous at the transport
  layer too; a report with no reporter field sent over an authenticated session
  is not anonymous to the server.

## Decisions still to make

1. **Per-sender cooldown.** Currently global, which punishes the person being
   targeted by a burst. Needs `senderId` on `ReportRecord` and a change to the
   history filter in `validateDraft`.
2. **What resolves `until_reviewed`.** There is no moderator side, so that
   setting currently hides a message forever.
3. **Whether reports should be encrypted to moderators** rather than sent as
   room events. Relevant given you are using Matrix crypto: a report carrying
   evidence is exactly the payload you would not want readable by the room.
4. **Reporting a user rather than a message.** The model is envelope-shaped
   throughout; user-level reports are a different subject type, not a flag.

---

## The wire, added later

`core/envelope.ts` + `core/packing.ts` now pack a report for the only channel that
will carry one. Findings:

1. **There is no report endpoint.** Not in the OpenAPI spec, not in
   `messaging-lambda`. Anything built here either adds one or rides Olm to-device.
   This is the finding; everything else follows from it.
2. **Moderating E2EE content requires handing over a copy.** A pointer is
   unactionable because the moderator holds no room key. The evidence copy is
   therefore load-bearing *and* a real privacy cost — not an implementation detail
   to be optimised away.
3. **Reporter-side and moderator-side actionability are different questions** and
   can disagree. Both are implemented; the gap between them is what to surface.
4. **Anonymity stops at the transport.** Olm identifies the device. Do not let the
   UI imply otherwise.
5. **Olm is per-device**, so delivery is a fan-out with a device count, and a
   moderator who has just reinstalled may have no device the reporter knows about.
6. **`viewOnce` media may already be spent.** Only the server knows; locally this
   is `subject_may_be_view_once`, an unknown rather than a failure.

Still open: whether reporting should get a real endpoint. That is a product and
trust-model question, not a packaging one — but the answer determines whether any
of the above survives.
