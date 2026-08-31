# SmartDialer

A runnable, testable, observable prototype of a modern outbound calling system — progressive
and predictive dialing, agent allocation, concurrency control, safety limits, retry and
timeout handling, deterministic simulation, and a live operational dashboard.

> ## ⚠️ This system cannot place real calls
>
> There is no real telecom integration in this repository. Only mock providers exist, the
> process **refuses to start** unless `SIMULATION_MODE=true`, and the API rejects any phone
> number outside the reserved fictional `+1-555-01xx` block. See `CONSTRAINTS.md` §1.

---

## Quick start

```bash
npm install
cp .env.example .env      # optional; the defaults work
npm run db:migrate
npm run seed
npm run dev               # API on :3000, dashboard on :5173
```

Open **http://localhost:5173**, go to **Campaigns**, and press **Start** on
*Q3 Renewals (Progressive)*.

---

## What it is

An outbound dialer's hard parts are not the phone calls. They are: deciding *how many* calls
to place when answers are probabilistic, never exceeding capacity when many things happen at
once, releasing resources correctly when things fail, and never calling someone you must not
call. This prototype implements those parts for real, and simulates only the telephony.

Three ideas hold the whole thing up:

**One clock, two drivers.** All time flows through a single `SimulatedClock`. `FastDriver`
drains it as fast as the CPU allows (tests, instant simulations); `PacedDriver` advances it
against real time, scaled (the live dashboard, 1×–100×). The dashboard and the test suite
therefore drive *the same engine along the same code path* — a green simulation test is
evidence about what you will see on screen, not about a parallel test-only implementation.

**Reserve before you dial, release exactly once.** A contact is claimed with an atomic
conditional `UPDATE`; a concurrency lease is acquired synchronously across three scopes before
the provider is ever called; and leases are idempotent objects, so a double release is a no-op
rather than silent capacity corruption. Nothing asynchronous happens between checking capacity
and claiming it.

**Predictive pacing bets on variance, not the mean.** The textbook formula
(`lines = agents / answerRate`) abandoned 26% of answered calls in testing — real people
picking up to silence. The pacer now solves `Lp + 1.5·√(Lp(1-p)) ≤ seats`, so expected answers
*plus their variance* fit the available agents. See `DECISIONS.md` D-013 and `BUG.md` B-004.

## Documentation map

| File | What it answers |
|---|---|
| `HANDOVER.md` | What works right now, what's next — **read first** |
| `ARCHITECTURE.md` | The shape of the system |
| `DECISIONS.md` | Why it is built this way (15 entries) |
| `CONSTRAINTS.md` | What must never be violated |
| `FLOW.md` | How execution travels through the code |
| `FEATURE.md` | Per-feature status and verification |
| `BUG.md` | Bugs found, root causes, regression tests |
| `TEST_CHECKLIST.md` | Executable verification with real recorded output |
| `ROLLBACK.md` | How to undo things safely |

## The demo, in five minutes

1. **Progressive dialing.** Start *Q3 Renewals*. Open its detail page and read the **"Why this
   many calls?"** panel — the dialer's own arithmetic, live. Progressive never dials more lines
   than it has free agents, so nobody is ever abandoned.

2. **Predictive dialing.** Start *New Product Outreach* (20 agents). Watch the same panel show
   the answer-rate estimate, the occupancy feedback, and the variance guard clamping the
   target. Peak concurrency exceeds the agent count — that is the over-dial — while the
   abandon rate stays near zero.

3. **Break the provider.** Go to **Provider** and press *All calls go silent*. The provider now
   accepts calls and never reports an outcome. About 45 seconds of simulated time later,
   `call.timeout` events appear in the event log, slots and agents are released, and retries
   are scheduled. Nothing deadlocks.

4. **Emergency stop.** Press it in the masthead. New calls stop immediately; the campaign
   detail page tells you why (`EMERGENCY_STOP`). Release it and dialing resumes.

5. **Simulations.** The **Simulation** tab runs any of eight predefined scenarios in an
   isolated engine and reports `INVARIANTS: PASSED/FAILED` along with whether the scenario
   demonstrated what it claims. Same seed ⇒ identical run.

Or from the command line:

```bash
npm run scenario -- predictive     # over-dials safely, limits authoritative
npm run scenario -- timeout        # watchdog fires, resources released
npm run scenario -- dnc            # zero calls to DO_NOT_CALL contacts
npm run scenario -- race           # activeCalls <= limit under many workers
```

Each exits non-zero on failure, so they work directly in CI.

## Dialing modes

**Progressive** — one line per free agent (configurable `lineRatio`). Every answered call has
someone waiting, so it never abandons anyone. The safe default.

**Predictive** — dials more lines than it has seats, betting on the answer rate. The bet's cost
when it goes wrong is an abandoned call, so the pacer is defensive: the answer-rate estimate
blends toward a *high* prior when evidence is thin (high, because the estimate is a divisor);
occupancy feedback is withheld until enough calls have completed; the abandon rate degrades
pacing before the hard limit stops it; and the variance guard caps the line count outright.

A consequence worth knowing: **a small predictive team is paced down to roughly one line per
agent.** That looks like the feature not working. It is the correct answer — five seats cannot
absorb an unlucky batch — and it is why predictive dialing is a large-team technique. The
`predictive-small-team` scenario demonstrates the restraint deliberately.

## Safety model

One ordered list of named rules (`src/services/safety.ts`), evaluated on every dial. There is
no code path from a strategy's decision to `provider.createCall()` that skips it.

```
emergency-stop → campaign-status → predictive-paused → abandon-rate →
contact-do-not-call → contact-eligible → max-attempts → retry-not-due →
agent-capacity → global-concurrency → campaign-concurrency →
provider-concurrency → rate-limit
```

Order is meaningful: absolute prohibitions first, so the reason reported is the most
fundamental one. The rate limiter is last because it is the only rule with a side effect.

Each rule returns an explainable decision, not a boolean — which is why the dashboard can
answer "why is this campaign not dialing?" with every rule currently denying rather than just
the first.

## Testing

```bash
npm run verify             # everything below, plus build + all 8 scenarios, in ~19s
```

Or individually:

```bash
npm run typecheck
npm run lint               # includes the determinism ban: no Date.now/Math.random/setTimeout
npm run test:unit          # 220 — pacing maths, backoff, safety rules, state machines
npm run test:integration   # 154 — repositories, engine end-to-end, providers, API
npm run test:concurrency   #  25 — slot races, double reservation, release races
npm run test:failure       #  25 — timeouts, outages, retry exhaustion, DNC, e-stop
npm run test:simulation    #  22 — seeded runs, all 8 scenarios, determinism digest
npm run test:web           #  25 — form validation, routing, API errors, event buffer
npm test                   # 471 total, ~6s
```

`npm run verify` runs every step even when an earlier one fails — "typecheck failed" and
"typecheck failed *and* four scenarios regressed" call for different responses. Its ability to
actually fail is itself verified: introducing a deliberate pacing bug makes it report
`VERIFICATION FAILED` and name the assertion (`TEST_CHECKLIST.md` row 55).

The determinism proof is a SHA-256 over the ordered event stream: run the same seed twice and
the digests match. It catches accidental non-determinism anywhere in the engine — timer
ordering, iteration order, an unseeded draw — not just in RNG use.

## Understanding the codebase

Read in this order: `src/core/clock.ts` (why everything else takes an injected clock), then
`src/services/safety.ts` (the policy, readable as a list), then
`src/services/dialer-engine.ts` `#attemptDial` (the ordering that makes concurrency correct),
then `src/dialer/predictive.ts` (the interesting maths).

```
src/core/        clock, seeded rng, event bus, state machines, errors
src/domain/      entities + the four state machines
src/db/          schema, migrations, repositories — the only place SQL exists
src/providers/   TelecomProvider interface + two mocks
src/dialer/      pacing strategies (pure functions)
src/services/    orchestration, concurrency, safety, retry, metrics, simulation
src/api/         Fastify routes + SSE
web/             React dashboard
```

---

## Prototype vs. production

**Implemented here**

* Progressive and predictive pacing, deterministic and unit-tested
* Concurrency limits at global, campaign and provider scope, enforced centrally
* Atomic contact reservation and atomic agent assignment
* A safety engine with explainable allow/deny decisions
* Failure classification, exponential backoff with jitter, timeout watchdogs with a
  lease-expiry backstop
* Mock providers with configurable, asynchronous, injectable failure — including going silent
* Full event log, live metrics, and continuously asserted invariants
* Reproducible simulation from a seed, with eight scenarios that assert their own claims
* A dashboard where every control performs a real action

**Would require production infrastructure**

* A real telecom provider integration, with its own rate limits, webhooks and reconciliation
* Multi-process operation — the concurrency ledger is in-memory and single-process by design
  (D-007). Two dialer processes against one database would each keep their own counters and
  collectively exceed the global limit; the contact lock would still hold.
* Regulatory compliance: calling-hours enforcement by timezone, jurisdictional abandon-rate
  rules, call recording, consent capture and audit retention
* A durable job queue for retries that survives process restart
* Authentication, authorisation and tenant isolation — there is none, which is why CORS is
  restricted to localhost
* Real observability: metrics export, tracing, alerting

This is a prototype for understanding and demonstrating dialer engineering behaviour. It is
not production telephony infrastructure.
