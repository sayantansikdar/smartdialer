# BUG

Meaningful bugs found during development, with their full trace preserved. Entries are
**not deleted after being fixed** — the history is the point. A bug that was hard to find
once is worth being able to recognise again.

Trivial typos and compile errors are not recorded here. A bug earns an entry when it was
non-obvious, when it revealed a wrong assumption, or when a regression test now exists
because of it.

---

## B-001 — Stopping a campaign silently desynchronised the concurrency ledger

**Status:** FIXED (Milestone 6)

**Observed behavior.** `campaignService.stop()` on a campaign with connected calls left the
in-memory concurrency ledger reporting 0 active calls while the database still held 2 calls
in `CONNECTED`. The invariant checker caught it:

```
InvariantViolationError: Invariant violated [concurrency ledger matches persisted active calls]:
ledger reports 0 active call(s) but the database has 2
```

**Expected behavior.** Stopping a campaign cancels every call in flight: each call reaches a
terminal state in the database *and* releases its concurrency slot.

**Reproduction steps.** `tests/integration/dialer-engine.test.ts` →
`Campaign controls > stop cancels everything in flight`. Start a campaign with long call
durations, run until calls are connected, call `stop()`, then assert invariants.

**Root cause.** The call state machine had no `CONNECTED -> CANCELLED` edge. `#settle`
attempted the transition, `#transitionCall` correctly refused it and logged a warning — but
then `#settle` continued and released the lease anyway. The result was a call row frozen in
`CONNECTED` forever while its slot went back to the pool.

The deeper lesson: `#transitionCall` deliberately does not throw on an illegal transition,
because a provider may legitimately report events late or out of order and one odd event
should not take down a campaign. That tolerance is right for *provider-driven* transitions
and wrong for *engine-driven* ones, where an illegal transition means the state machine is
missing an edge the engine actually needs.

**Affected components.** `src/domain/call.ts`, `src/services/dialer-engine.ts` (`#settle`).

**Fix.** Added `CANCELLED` as a legal target from `CONNECTED` and `ON_HOLD`. This is the
honest model, not a workaround: an emergency stop or a campaign stop genuinely can terminate
a live conversation, and that should be recorded as cancelled rather than as a normal end.

**Regression test.** `Campaign controls > stop cancels everything in flight` asserts the
campaign reaches `STOPPED`, no calls remain in flight, the ledger reads zero, a
`call.cancelled` event was emitted, and `invariants.assert()` passes.

**Verification.** Test fails against the pre-fix state machine with the invariant error
above; passes after. Full suite green (314 tests).

**Note for the future.** This bug was found only because the invariant checker compares the
in-memory ledger against the database on every check. Neither source alone looked wrong.
That comparison is the single highest-value check in `src/services/invariants.ts`.

---

## B-002 — Each dialer tick was slower than the last

**Status:** FIXED (Milestone 6)

**Observed behavior.** Engine integration tests ran for 10+ real seconds and hit their
`maxRealMs` guard instead of completing. A 25-contact campaign never finished.

**Expected behavior.** A campaign of this size completes in well under a second of real time
under the fast driver.

**Reproduction steps.** Run a predictive campaign with 25–60 contacts to completion and
measure wall time per tick.

**Root cause.** `DialerEngine.buildSnapshot()` — called once per tick — used
`MetricsService.campaignMetrics()` to obtain a single number, the historical answer rate.
That method assembles a full reporting bundle, including `EventRepository.countByType()`,
which is a `GROUP BY` over the entire events table.

The events table grows for the whole run, and the engine emits events on every tick. So each
tick aggregated a larger table than the last: quadratic work, invisible at small scale and
crippling by a few thousand events.

**Affected components.** `src/services/dialer-engine.ts` (`buildSnapshot`),
`src/services/metrics.ts`.

**Fix.** Added two narrow, indexed queries for the hot path —
`CallRepository.answerStatistics()` and `ContactRepository.readyCount()` — and used those in
`buildSnapshot` instead of the reporting bundle. `campaignMetrics()` remains, unchanged, for
the API and reports, where it runs once per request rather than once per tick.

**Regression test.** No dedicated timing test — a wall-clock assertion would be flaky on a
loaded machine. Instead the whole engine suite runs under the fast driver with a
`maxRealMs: 10_000` guard, so a regression of this kind fails the suite by timing out. Suite
runtime went from 41s (failing) to 0.5s.

**Verification.** `tests/integration/dialer-engine.test.ts`: 29 tests, 41.6s → 0.495s.

**Note for the future.** Anything called per tick belongs to the hot path. Reporting
aggregates are fine per request and never fine per tick — and the difference does not show up
until the data is big enough to hurt.

---

## B-003 — A campaign paused by the abandon-rate control span forever instead of standing down

**Status:** FIXED (Milestone 6)

**Observed behavior.** A predictive campaign with a high abandon rate never terminated. In
4 seconds of real time it accumulated:

```
virtual time     : 9,843,781 ms  (2.7 hours simulated)
dialer.plan      : 39,370 events
contact.reserved : 39,001 events
contact.released : 38,969 events
safety.denied    : 38,969 events  (all ABANDON_RATE_EXCEEDED)
contacts         : 13 still READY, campaign still RUNNING
predictivePausedReason : null
```

**Expected behavior.** Once abandonment crosses the threshold, the campaign latches into a
paused state, records `safety.abandon_threshold_exceeded`, stops dialing, and waits for an
explicit operator resume.

**Reproduction steps.** `Determinism > two runs with the same seed produce identical event
streams` — a predictive campaign, 3 agents, 25 contacts, 60% answer rate. Before the fix it
timed out at 20s.

**Root cause.** Two independent mistakes that combined into a livelock.

1. **The pause could never latch.** `#checkAbandonThreshold` was only called from
   `#abandon`. But the safety engine *denies* dialing the moment the abandon rate is
   breached — so no more calls are placed, so no more calls are abandoned, so the handler
   that would have latched the durable pause is never called again. The transient denial
   permanently prevented the durable pause that was supposed to replace it.

2. **Denial was expensive.** `#attemptDial` reserved a contact *before* evaluating safety.
   For a campaign-wide denial (nothing to do with any particular contact) that meant
   reserve → deny → release, every attempt, every tick — roughly 39,000 wasted
   reservations and three events each.

**Affected components.** `src/services/dialer-engine.ts` (`tick`, `#attemptDial`,
`#checkAbandonThreshold`), `src/services/campaign-service.ts` (`resumePredictive`).

**Fix.** Three changes:

* `#checkAbandonThreshold` is now evaluated **on every tick**, not only when an abandon
  occurs, so the pause latches from the same condition that triggers the denial.
* Added `#campaignGate` — the campaign-wide safety rules evaluated once per tick with no
  contact and without consuming rate-limit allowance. A campaign that cannot dial at all no
  longer touches the contact pool.
* Added the **stand-down**: when a campaign is blocked by a condition requiring deliberate
  operator action (predictive pause, emergency stop) and has nothing in flight, the engine
  stops scheduling ticks and records why. `resumeStalled()` brings it back, triggered by
  `CampaignService.resumePredictive()` and by a `safety.emergency_resume` subscription.

**Regression test.** The determinism tests, which only terminate if the campaign reaches a
settled state. Plus `Emergency stop > lets dialing resume once released`, which fails if
`resumeStalled` does not fire.

**Verification.** Test went from a 20s timeout to passing; the whole engine suite runs in
0.5s.

**Note for the future.** The general shape here is worth remembering: *a transient guard that
suppresses the very event a durable guard depends on.* The stand-down also matters beyond
tests — on the live dashboard, the pre-fix behaviour was a campaign displaying RUNNING while
burning CPU and never dialing, with nothing on screen explaining why.

---

## Toolchain issues (not defects in this project)

Recorded in `HANDOVER.md` under "Verified environment facts":

* `eslint@^9.40.0` does not exist — the 9.x line stops lower. Moved to ESLint 10, which
  `typescript-eslint@8.68` supports.
* ESLint 10 does not bundle `@eslint/js` — added as an explicit devDependency.

---

## B-004 — Predictive dialing abandoned 26% of the people who answered

**Status:** FIXED (Milestone 6)

**Observed behavior.** A 5-agent predictive campaign with 100 contacts:

```
Successful connections   68
Abandoned                24        <-- 26% of answered calls
Abandon rate             26.1%     (configured maximum: 3.0%)
Peak concurrency         15        (5 agents)
INVARIANTS: PASSED
```

Every concurrency limit was honoured. Every invariant held. The system was working exactly as
designed and the design was wrong — twenty-four people picked up the phone to silence.

**Expected behavior.** Abandonment stays at or below the configured maximum. Over-dialing is
the point of predictive dialing, but its entire cost is borne by the person who answers, so
exceeding the threshold by 8x is not a tuning problem, it is a broken algorithm.

**Reproduction steps.** `npm run scenario -- predictive` against the pre-fix pacer (5 agents,
100 contacts, 65% answer rate).

**Root cause.** Three compounding mistakes, all in `PredictiveDialer.computeDialPlan`.

1. **Pacing on the mean.** The textbook formula `lines = agents x multiplier / answerRate`
   balances the *expected* number of answers against available seats. But answers are
   binomial. Eight lines at a 50% answer rate averages four answers — and roughly one batch in
   seven produces more answers than there are agents. Pacing to the expected value guarantees
   you overshoot about half the time; every excess answer is an abandoned call.

2. **A low cold-start answer-rate estimate.** With no completed calls the estimate started
   near zero, and the estimate is a *divisor* — so an early run of no-answers asked for a
   near-unbounded number of lines at exactly the moment the system knew least.

3. **Occupancy feedback boosting on no evidence.** At campaign start, occupancy is 0 because
   nothing has happened yet, not because the dialer is under-dialing. The feedback loop read
   that as "lean in" and multiplied an already-inflated line count.

**Affected components.** `src/dialer/predictive.ts`.

**Fix.** Four changes, the first being the substantive one:

* **A variance guard.** Pace so that expected answers *plus a variance margin* fit the seats:
  solve `Lp + k·sqrt(Lp(1-p)) <= seats` for `L`, with `k = 1.5` sigma. Closed form, pure
  function, its own unit tests. This is `varianceCap()`.
* **A high cold-start prior (0.9).** High is the conservative direction, because the estimate
  is a divisor — a high assumed answer rate produces *fewer* lines. The campaign now opens at
  roughly one line per agent and ramps up as it learns.
* **Confidence-weighted blending** of the observed rate toward that prior, so two no-answers
  cannot read as a 0% answer rate.
* **Occupancy feedback withheld** until `occupancyMinSample` calls have completed.

The behaviour this produces matches how real predictive dialing works: **the safe over-dial
ratio grows with team size.** Five seats at a 50% answer rate permits about six lines (1.2x);
twenty seats permits about thirty-one (1.55x).

**Regression test.** `tests/unit/pacing.test.ts` — 46 tests, including "keeps expected answers
plus variance within available seats", "permits a larger over-dial ratio for a larger team" and
"never paces below progressive dialing". Plus two scenarios: `predictive` (20 agents — must
over-dial, and abandon rate must stay under 5%) and `predictive-small-team` (5 agents — must
abandon *nobody*, even at the cost of not over-dialing).

**Verification.** Post-fix, the same 5-agent configuration: **0 abandoned**, all 100 contacts
processed, 72.5% agent utilisation. The 20-agent `predictive` scenario: peak concurrency 21
against 20 agents with a **0.0%** abandon rate.

**Note for the future.** The most uncomfortable thing about this bug is that the test suite was
green throughout. Every invariant held, because none of them said anything about abandonment —
they bounded concurrency, capacity and attempts, and abandonment is not a limit violation, it
is a *quality* failure that occurs entirely within the limits. Invariants tell you the system
did not break its own rules. They cannot tell you the rules were sufficient.

The second lesson is smaller but sharper: a 5-agent predictive campaign is now paced down to
roughly 1:1, which looks exactly like the feature not working. It is the correct answer. The
`predictive-small-team` scenario exists so nobody "fixes" it back. See DECISIONS.md D-013.

---

## B-005 — A restarted server collided with its own persisted ids and took the dialer down

**Status:** FIXED (Milestone 7)

**Observed behavior.** After `npm run seed && npm run dev`, every write failed:

```
POST /api/campaigns/camp_000001/start  ->  500 INTERNAL_ERROR
Error: UNIQUE constraint failed: events.id
  at EventRepository.insertMany (src/db/repositories/event-repository.ts:66)
  at EventService.flush (src/services/event-service.ts:112)
  at CampaignService.start (src/services/campaign-service.ts:195)
```

and, a tick later:

```
Dialer tick failed: UNIQUE constraint failed: events.id
```

**Expected behavior.** A server restarted against an existing database continues numbering
from where the previous process stopped, and starting an already-running campaign returns a
clean `409` rather than a `500`.

**Reproduction steps.** `npm run db:reset && npm run seed && npm run dev`, then
`curl -X POST localhost:3000/api/campaigns/camp_000001/start`.

**Root cause.** `IdGenerator` is intentionally sequential rather than random, so ids are
readable and runs are comparable (DECISIONS.md D-004). But the counters live in memory and
start at 1 in every process, while the database persists. The seed script wrote
`evt_000001…evt_0000xx`; the server then started fresh and its very first event insert
collided.

The severity came from *where* it collided. Events are written on every state transition, so
the failure was not confined to one endpoint — it broke the dialer tick as well, meaning a
seeded demo could not dial at all.

Two things hid this until now: every test uses a fresh `:memory:` database, and every
simulation builds its own container. Nothing in the suite had ever reopened a populated
database — which is exactly the configuration a user runs.

**Affected components.** `src/core/ids.ts`, `src/container.ts`, and every write path through
`EventService.flush`.

**Fix.** `IdGenerator.restore(prefix, highestIssued)` plus `src/db/id-recovery.ts`, which
reads the high-water mark per entity table at container construction and moves each counter
forward. `restore` only ever increases a counter, so it cannot reintroduce the collision.

Ids matching only `<prefix>_<digits>` are considered, so readable custom ids in seed data
(`agent_prog_01`) do not skew the counter. A fresh in-memory database restores nothing, so
tests and simulations remain byte-for-byte deterministic.

**Regression test.** `tests/integration/id-recovery.test.ts` → "does not reissue ids that
already exist" builds a container against a real file, closes it, reopens a second container
against the same file and asserts that writing succeeds and ids continue. Also covers
`restore` never moving a counter backwards.

**Verification.** Test fails with `UNIQUE constraint failed: events.id` against the pre-fix
container; passes after. Live server re-verified end to end: seed, restart, start campaign,
calls placed, emergency stop honoured.

**Note for the future.** Determinism and persistence pull in opposite directions here. The
tests were all deterministic *because* they were all ephemeral, and that is precisely why
they could not see this. A prototype whose test suite never touches a persistent database has
an untested startup path.

---

## B-006 — A trailing slash routed to a campaign that does not exist

**Status:** FIXED (post-Phase B, found by the first frontend test)

**Observed behavior.** `parseRoute('#/campaign/')` returned `{ view: 'campaign', param: '' }`.
The detail view then requested `/api/campaigns/` with an empty id, which 404s, leaving a
broken page instead of the campaign list the trailing slash obviously meant.

**Expected behavior.** An empty path segment is not a parameter. `#/campaign/` should behave
like `#/campaign` — which the router already handles by falling through to the list.

**Reproduction steps.** `web/tests/logic.test.ts` → `Route parsing > defaults to the
dashboard`, with the input `'#//'`. Or in the browser: navigate to `#/campaign/`.

**Root cause.** `const [view = '', param] = path.split('/')` gives `param` a default only when
the segment is *absent*. `'campaign/'.split('/')` yields `['campaign', '']` — the segment is
present and empty, so the default never applied and `param ?? null` passed the empty string
straight through.

**Affected components.** `web/src/lib/router.ts`.

**Fix.** Treat an empty segment as no parameter:
`param: param === undefined || param === '' ? null : param`.

**Regression test.** `web/tests/logic.test.ts` asserts that `''`, `'#'`, `'#/'` and `'#//'` all
resolve to the dashboard with a null parameter.

**Verification.** The test failed with `param: ''` before the fix and passes after.

**Note for the future.** Minor in impact, but it is the *first* thing the frontend test suite
found, on the first run, in a thirty-line module — which is the argument for the suite. The
web layer had been verified by browser automation, and browser automation only exercises the
paths someone thought to click. A trailing slash is not one of them.
