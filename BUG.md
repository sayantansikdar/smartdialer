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

---

## B-007 — The `.env` file the README tells you to create was never read

**Status:** FIXED (found while running the app)

**Observed behavior.** `README.md` and `.env.example` both instruct the user to
`cp .env.example .env` and edit it. Nothing in the repository ever loaded that file. Every
setting in it — `SIMULATION_SPEED`, `GLOBAL_MAX_CONCURRENT_CALLS`, `DATABASE_PATH`,
`PROVIDER_TIMEOUT_MS`, all of it — was silently ignored, and the process ran on defaults.

**Expected behavior.** Values in `.env` take effect.

**Reproduction steps.** Write `SIMULATION_SPEED=3` into `.env`, run `npm run dev`, and observe
the boot banner still reporting `Clock speed 10x`.

**Root cause.** `loadConfig()` reads `process.env` and nothing else, which is correct and
deliberate — it keeps the function pure and testable (CONSTRAINTS.md §3: one module reads the
environment). The missing half was that no entry point ever *populated* `process.env` from a
file. There is no `dotenv` dependency and no `--env-file` flag on any script.

The failure mode is the worst kind: entirely silent. A user setting a lower concurrency limit
would believe they had, and get the default.

**Why the tests could not see it.** Every test calls `loadConfig(literalObject)` or
`testConfig()`, passing configuration in directly. Nothing in the suite ever exercised the path
a real user takes — file to `process.env` to `loadConfig()` — because the tests deliberately do
not depend on ambient environment. The same property that makes config testable is what hid
this.

**Affected components.** `package.json` scripts, `scripts/dev.mjs`.

**Fix.** `--env-file-if-exists=.env` on every entry point that reads configuration: `dev:api`,
`start`, `db:migrate`, `db:reset`, `seed`, `scenario`, and the API process spawned by
`scripts/dev.mjs`. Node loads it natively, so no dependency was added, and the
`-if-exists` variant means a missing `.env` is not an error.

**Verification.** `SIMULATION_SPEED=3` in `.env` → boot banner reads `Clock speed 3x` and
`/api/system/status` reports `speed: 3`. `GLOBAL_MAX_CONCURRENT_CALLS=37` → config reports 37.

Separately confirmed that the newly-live path **cannot be used to disable the safety gate**:
`SIMULATION_MODE=false` in `.env` still refuses to start with `SIMULATION_MODE_REQUIRED`,
because the gate lives in `loadConfig` and does not care where the value came from.

**Note for the future.** This is the third bug in this project found by *running* the thing
rather than testing it (with B-005, the restart collision, and B-006, the trailing-slash
route). All three lived in the seam between a well-tested component and the way a real user
reaches it. A suite that isolates its units perfectly will never cover those seams — which is
an argument for the smoke path in `npm run verify`, not against the isolation.

---

## B-008 — A fresh clone could not start: the database directory did not exist

**Status:** FIXED (found by a cold-start test)

**Observed behavior.** On a clean checkout, running `npm run dev` without first running
`npm run db:migrate` failed with:

```
Failed to start: Error: unable to open database file
    at new Database (src/db/database.ts:33:16)
```

**Expected behavior.** `npm run dev` works on a fresh clone. The container already runs
migrations at startup, so the only thing standing in the way was a missing folder.

**Reproduction steps.** Copy the repository without `data/`, `npm install`, then `npm run dev`.

**Root cause.** SQLite will not create a missing parent directory, and `data/` is gitignored so
it does not exist on a fresh clone. Its error message — "unable to open database file" — names
neither the file nor the reason, and reads like corruption rather than a missing folder.

**Affected components.** `src/db/database.ts`.

**Fix.** `mkdirSync(dirname(path), { recursive: true })` in the `Database` constructor, skipped
for `:memory:`. Combined with the migrations the container already ran, this means a fresh
clone now needs **only** `npm install && npm run dev` — `db:migrate` and `seed` became
optional conveniences rather than prerequisites.

**Verification.** Cold-start test: clean copy, no `data/`, no `.env`, no migrate, no seed →
API up, `/api/campaigns` returns `[]`, `data/` created automatically.

**Note for the future.** Two further startup failures were made actionable at the same time,
though neither was a defect as such: `EADDRINUSE` now suggests a free port and how to find
what is holding the current one, and a database-open failure names the path and the command to
rebuild it. Both are hit by someone who has not got the app running yet — the worst possible
moment to be handed a stack trace.

---

## B-009 — A finished campaign was a dead end

**Status:** FIXED

**Observed behavior.** Not a crash — a usability dead end that made the project fail its own
"completely runnable" claim. Seeded campaigns have finite contacts. Once a campaign worked
through them it moved to COMPLETED, and there was no way to run it again from the dashboard:
`start` correctly refused (no contacts remaining), and COMPLETED was terminal. The only way
back was `npm run db:reset && npm run seed` in a terminal.

Observed live: opening the dashboard after a demo showed three campaigns, all inert, with
nothing to press.

**Expected behavior.** A finished demo campaign can be run again from the UI.

**Root cause.** The domain modelled *resuming* but not *resetting*, and only the former was
ever ruled out. Continuing a finished run should indeed be impossible; discarding it and
starting over is a different operation that simply had no representation.

**Affected components.** `src/domain/campaign.ts`, `src/services/campaign-service.ts`,
`src/db/repositories/contact-repository.ts`, `src/api/routes/campaigns.ts`, and both campaign
views.

**Fix.** `POST /api/campaigns/:id/reset`, plus a Reset button on the campaign list and detail
pages. It returns unsuccessful contacts to the pool with their attempt counters cleared, moves
the campaign to READY, and clears any abandon-rate pause (which measured a run that no longer
exists). It refuses while the campaign is still running.

Two contact states are deliberately **not** restored:

* `DO_NOT_CALL` — a one-way door everywhere else in the system. A reset that quietly reopened
  it would mean the whole DNC guarantee held right up until someone pressed a button labelled
  "run it again".
* `COMPLETED` — someone already reached that person; a demo reset is not a reason to call them
  a second time.

`COMPLETED -> READY` and `FAILED -> READY` were added to the campaign state machine as
explicit reset-only edges, rather than writing the status directly. Bypassing the machine
would have made it a description of *some* transitions instead of all of them, which is the
only property that makes it worth having. Neither edge leads to RUNNING, so nothing can
silently resume.

**Regression test.** `tests/failure/campaign-reset.test.ts` — 7 tests, led by "never restores a
DO_NOT_CALL contact", which resets and then runs a **second full campaign** before asserting
`callsToDoNotCallContacts()` is still empty.

**Verification.** All 7 pass; `npm run verify` green at 19/19.

---

## B-010 — Three duplicate ANSWERED events reserved three agents for one call

**Status:** FIXED

**Observed behavior.** The assignment asks directly: *"the provider sends ANSWERED, ANSWERED,
ANSWERED, COMPLETED — does your system create multiple state transitions?"* It did. Three
deliveries of the same event pulled three agents out of the pool for one conversation; two of
them were never spoken to.

**Root cause.** Two layers, and the top one ignored the bottom. `#transitionCall` used a
compare-and-set and correctly refused the duplicate — but returned `void`, so
`#handleAnswered` had no way to know, and carried straight on to reserve an agent. The
idempotency existed and was thrown away one line later.

A second instance of the same shape in `#settle`: it set `settled = true` and released the
concurrency lease *before* checking that the terminal transition was legal. A stale
out-of-order event (a `NO_ANSWER` for a call that had since connected) therefore released the
slot while leaving the call row active — the in-memory ledger silently disagreeing with the
database, which is B-001's failure mode reappearing in a different path.

**Fix.** `#transitionCall` returns whether it applied, and `#handleAnswered` returns early
when it did not. `#settle` verifies the transition is reachable *before* committing to settle,
and ignores the event otherwise. Terminal states reachable from everywhere (TIMEOUT,
CANCELLED) stay always-legal so the watchdog and stop paths can never be blocked by the check.

**Regression test.** `tests/failure/event-integrity.test.ts` — 6 tests, including replaying a
captured ANSWERED twice and asserting the agent count does not move, and a full campaign
against a provider that duplicates and reorders at random.

**Note.** There is deliberately no de-duplication layer and no event-id bookkeeping.
Idempotency falls out of the transition being conditional, which is why it also covers
duplicates nobody anticipated.

---

## B-011 — The reported abandon rate was 0% while 29 people were abandoned

**Status:** FIXED

**Observed behavior.** A scenario report showing `Abandoned 29` and `Abandon rate 0.0%` in the
same block.

**Root cause.** `abandoned / answered`. An abandoned call *was* answered — a person picked up
— but it carries `outcome = 'ABANDONED'`, so it was excluded from its own denominator. When
every answered call was abandoned, `answered` was zero and the rate read 0%.

**Fix.** Denominator is `answered + abandoned` — everyone who picked up.

**Note.** The rolling window the *safety control* reads was already correct, so the control
itself was never fooled. What was broken was the number a **human** reads to decide whether
the system is behaving — which for a compliance metric is arguably worse.

---

## B-012 — The watchdog killed every conversation longer than 45 seconds

**Status:** FIXED

**Observed behavior.** Scenarios with 120s and 180s talk times produced 60 timeouts and
**zero** successful connections, against a provider configured to answer 70% of calls.

**Root cause.** One watchdog, armed at call creation, covering the whole lifecycle, measured
against `PROVIDER_TIMEOUT_MS` (45s). A conversation is silent — nothing is emitted while two
people talk — so every call longer than the setup timeout was declared a provider failure.

Invisible until now because the default simulated talk time is 25 seconds. The assignment's
own scenario table exposed it on the first run.

**Fix.** Two phases, two timeouts. Setup (`created → answered`) keeps `PROVIDER_TIMEOUT_MS`;
the conversation phase gets a new `MAX_CALL_DURATION_MS` (30 min), and the watchdog is re-armed
when the call connects. Startup validation rejects a configuration where the call ceiling does
not exceed the setup timeout.

---

## B-013 — The abandon-rate control fired 13 abandons too late

**Status:** FIXED

**Observed behavior.** In the 70%-answer-rate scenario, abandonment began at t=121,494 and the
control did not latch until t=143,876 — 22 seconds and 13 abandoned people later.

**Root cause.** `abandonMinSample: 20`. The control waited for twenty answered calls before it
would act, which is a strange thing to require of a metric where every sample is a person
hearing silence.

**Fix.** Act on the **Wilson score interval's lower bound** instead — the most optimistic rate
still consistent with what has been observed. 3 abandons out of 5 gives a lower bound around
23%, enough to act on immediately; 1 out of 5 gives about 4%, and the control correctly waits.
It reacts fast when the evidence is strong and stays quiet when it is not, which a fixed
minimum sample cannot do. Abandonment in the affected scenarios roughly halved.

---

## B-014 — Every abandonment was logged twice

**Status:** FIXED

**Observed behavior.** `call.abandoned` events appeared in exact pairs — 26 events for 13
abandonments.

**Root cause.** `#abandon` emitted the event explicitly, and `#settle` emitted it again via
`EVENT_FOR_OUTCOME`.

**Fix.** Removed the explicit emission. Small, but it doubled the apparent size of the one
problem this system most needs to report accurately.

---

## B-015 — Predictive pacing abandoned too much with long talk times

**Status:** ROOT CAUSE FIXED. A residual weakness at very low answer rates remains, newly
characterised below.

**Observed behavior.** With 180-second talk times and a 70% answer rate (`pacing-c`), the
campaign abandons around 20% of answered calls before the safety control latches and stops it.
`pacing-a` shows ~13%.

**What is not wrong.** Every limit holds; invariants pass at every step; the abandon-rate
control detects the condition, latches a durable pause and stands the campaign down awaiting a
human. The *guarantee* is intact — this is a failure of the *guess*.

**What I ruled out, by measurement rather than reasoning.** Raising the pacer's variance guard
from 1.5σ to 2.0σ: no measurable change. Adding an independent variance bound in the Safety
Controller: no change, because the pacer's own bound was already tighter and binding first.
Neither hypothesis survived contact with the numbers.

**Current best explanation.** The pacer treats *currently free seats* as its capacity, but with
180-second calls the seats free when a batch is dialled are not the seats free four seconds
later when it is answered — other in-flight calls claim them first. `pendingConnections`
accounts for calls in flight but not for the *rate at which seats become free*, which with long
calls is close to zero. Short-call scenarios do not show the problem because seats recycle fast
enough to absorb the error.

### Root cause, found later

Not a modelling subtlety at all — an arithmetic bug feeding the pacer a **negative** number.

Instrumenting the plans immediately before the first abandonment showed:

```
t      avail  pending   req -> app   verdict
114964     1      -19    20 -> 10    REDUCED
116358     3      -13    16 -> 10    REDUCED
```

`pendingConnections` was negative. The pacer *subtracts* it, so a value of −19 silently **added
nineteen lines of phantom capacity**: with one free agent, ten calls were approved.

Three faults compounded:

1. **`buildSnapshot` computed `pendingConnections` as `ledgerActiveCalls − connectedCalls`** —
   two different sources subtracted from each other. The first came from the concurrency
   ledger, the second from the in-flight map. Nothing kept them in step.
2. **The concurrency lease TTL was `providerTimeoutMs * 2` = 90 seconds**, shorter than a
   180-second conversation. Every long call had its slot reclaimed *mid-conversation*. This is
   B-012's mistake repeated: I fixed the watchdog to distinguish setup from conversation and
   did not fix the lease that backs it.
3. **Reclaiming a lease released the slot but left the call in `#inFlight`** — so the ledger
   dropped while the in-flight map did not, driving the subtraction negative.

### Fix

* Lease TTL is now `(providerTimeoutMs + maxCallDurationMs) * 2`, so the backstop outlives the
  longest call its watchdog would tolerate.
* Reclaiming a lease now settles the call. Releasing a slot while leaving the call alive was
  the ledger/database divergence the invariant checker exists to catch.
* `pendingConnections` is derived from the in-flight map alone, and clamped at zero. A count
  of things in flight has no meaningful negative value.

### Result

| scenario | before | after |
|---|---|---|
| `pacing-b` | 35 connected · 5.4% abandon · 62% util | **269 · 0.4% · 84.5%** |
| `pacing-c` | 24 connected · 22.6% abandon · 54% util | **189 · 0.0% · 94.1%** |
| `pacing-d` | 36 connected · 5.3% abandon · 67% util | **142 · 0.0% · 84.2%** |

Roughly eight times the throughput at a fraction of the abandonment.

### What remains, and what it is not

`pacing-a` (20% answer rate) and `agent-drop` still abandon 13–26%. Two things are now known
about that which were not before:

* **It is not the variance guard.** Sweeping `safetyBufferSigmas` from 1.5 to 3.0 changes those
  two scenarios by *exactly nothing* — identical connections, utilisation and abandon rate at
  every value. The guard is not the binding constraint there, so tuning it is pointless.
* **It is worst where the over-dial is largest.** A 20% answer rate implies dialing ~5x, which
  is where the absolute number of simultaneous answers is greatest and the pacer's
  instantaneous view of free seats is least representative of the seats that will exist four
  seconds later when the batch is answered.

The next thing to try is the time-to-free-seat model — treating capacity as a forecast over the
ring window rather than an instantaneous count. The `pacing-*` scenarios are the harness for
evaluating it.

**Why the expectations do not assert a low abandon rate.** They assert the safety properties —
limits respected, invariants intact, control engaged — because loosening a bound until it
passes would hide precisely this. See `src/sim/scenarios.ts`.

---

## B-016 — The contact-reservation query sorted the whole campaign, per dial attempt

**Status:** FIXED

**Observed behavior.** `npm run load`: 60× the agents cost 243× per tick. At 3,000 agents
utilisation collapsed to 6%.

**Root cause.** `reserveNext` orders by `(next_attempt_at, id)`. Every freshly imported contact
has `next_attempt_at = NULL`, so they all compare equal and the index — which stopped at
`next_attempt_at` — could not satisfy the tiebreak. SQLite fell back to `USE TEMP B-TREE FOR
ORDER BY` and sorted **every dialable contact in the campaign** to pick one row, once per dial
attempt.

**Fix.** `migrations/002` extends the index to `(campaign_id, status, next_attempt_at, id)`,
making it a covering-index lookup. Measured: 722 µs → **17.9 µs** at 1,500 agents, and flat —
the same cost at 1,500 as at 200.

**Note on how it was found.** Two earlier "fixes" moved the number by nothing at all: replacing
an O(n) in-memory scan with a counter, and removing a redundant `CASE` from the same ORDER BY.
Both were correct improvements and neither was the bottleneck. Only profiling the individual
operations found it. Worth remembering the next time a performance hypothesis feels obvious.

The curve is still superlinear (205× for 60×) — `SCALE.md` names what is next and why.

---

## B-017 — A campaign with no agents online spun forever

**Status:** FIXED

**Observed behavior.** Taking the last agent offline mid-campaign produced, in a single test
run:

```
safety.denied   : 200,004 events
virtual clock   : 50,001 s
real time       : 8,741 ms   (stopped only by the run's real-time guard)
campaign status : RUNNING
```

The campaign ticked forever, denying every dial, doing nothing.

**Expected behavior.** A campaign that provably cannot dial stands down and waits for the
condition to change.

**Reproduction.** Start a campaign, take every agent offline, let it run.

**Root cause.** B-003 introduced a stand-down for campaigns blocked by something requiring
deliberate operator action, and enumerated exactly two such conditions: an abandon-rate pause
and the emergency stop. "Every agent is offline" is the same kind of condition — nothing the
engine does will change it — but it was not in the list, so the campaign kept ticking.

**Affected components.** `src/services/dialer-engine.ts`.

**Fix.** Added "no agents are online" to the stand-down conditions, and subscribed the engine
to `agent.available` so an agent returning revives a stood-down campaign. That second half
matters as much as the first: a stand-down with no way back is a worse bug than the spinning
it replaced.

**Regression test.** `tests/failure/stand-down.test.ts` — asserts the campaign stands down, that
the event count stays small rather than exploding, and that bringing an agent back resumes
dialing.

**Verification.** Same scenario after the fix: **2 ms**, 23 denials, 6 s of virtual time,
`stalled: true`. Bringing the agent back online resumed dialing immediately.

**Note for the future.** This is the third time the same shape has appeared: a campaign that
cannot proceed burning cycles instead of standing down. The condition list in `tick` is worth
treating as a checklist whenever a new blocking condition is introduced — "can the engine
itself ever clear this?" If not, it belongs in the stand-down.

---

## B-018 — Every scenario was measuring the mock provider's capacity, not the pacer

**Status:** FIXED

**Observed behavior.** Peak concurrency pinned at ~41 in every predictive scenario, regardless
of team size or campaign limit. A probe at 20, 40 and 80 agents produced peak concurrency of
41, 41 and 41.

**Root cause.** `SimulationService` scaled `GLOBAL_MAX_CONCURRENT_CALLS` and
`PROVIDER_MAX_CONCURRENT_CALLS` to the scenario, but not `MockProviderConfig.maxConcurrentCalls`
— the mock provider's *own* internal capacity, which defaults to 40. A campaign configured for
60 concurrent calls silently got 40, and the provider's rejections looked like ordinary
backpressure.

**Fix.** The simulation now gives the provider at least twice the campaign's limit unless the
scenario deliberately constrains it.

**Note.** This had been *masking* B-015: the 40-call ceiling limited the over-dial and therefore
the abandonment. Lifting it made `pacing-a` visibly worse (13% → 26%) — the cap was hiding the
problem, not solving it, and a scenario that measures the provider's ceiling instead of the
pacer measures nothing worth knowing.
