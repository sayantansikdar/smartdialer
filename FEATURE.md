# FEATURE

Traces each major feature from problem to verification. Updated as milestones land — a
feature's status is only moved to **Done** once it is implemented, tested *and* verified.

**Status legend:** `Planned` · `In progress` · `Done` (implemented + tested + verified)

---

## Status board

| # | Feature | Milestone | Status |
|---|---|---|---|
| 0 | Scaffold, toolchain, docs framework | 1 | **Done** |
| 1 | Core primitives (clock, RNG, events, state machines, config) | 2 | **Done** |
| 2 | Database, migrations, repositories | 3 | **Done** |
| 3 | Domain model + four state machines | 3 | **Done** |
| 4 | Provider abstraction | 4 | **Done** |
| 5 | Mock providers (reliable + unreliable) | 4 | **Done** |
| 6 | Concurrency controls | 5 | **Done** |
| 7 | Safety controls | 5 | **Done** |
| 8 | Failure handling, retry, timeouts | 5 | **Done** |
| 9 | Progressive dialer | 6 | **Done** |
| 10 | Predictive dialer | 6 | **Done** |
| 11 | Campaign / contact / agent management | 6–7 | **Done** |
| 12 | Event log + metrics | 7 | **Done** |
| 13 | REST API + SSE | 7 | **Done** |
| 14 | Simulation engine + 8 scenarios | 8 | **Done** |
| 15 | Seed data + demo flow | 8 | **Done** |
| 16 | Testing infrastructure (471 tests, 6 suites) | throughout | **Done** |
| 17 | Dashboard (9 views) | 9–10 | **Done** |
| 18 | Failure injection UI | 11 | **Done** |
| 19 | Final documentation pass | 12 | **Done** |
| 20 | Frontend logic tests + one-command verification | post-12 | **Done** |

**Both phases are complete and verified**, including browser-driven verification that every
dashboard control changes real server state.

---

## F-000 — Scaffold, toolchain and documentation framework

**Status:** Done (Milestone 1)

**Problem.** The prototype needed a home, a toolchain that could run TypeScript with strict
guarantees, and a documentation structure that lets another engineer or AI session pick the
work up cold. Without the docs framework in place *first*, the reasoning behind early
decisions would be lost by the time anyone thought to write it down.

**Requirements.**
* Self-contained project that does not disturb the surrounding workspace repository.
* TypeScript strict mode; a runtime that can execute it without a build step if possible.
* Mechanical enforcement of the determinism constraint, not just prose.
* All nine mandated documents present with real content.

**Implementation plan.** Verify the runtime assumptions experimentally before committing to
them → create the directory skeleton → install and pin dependencies → write the ESLint
determinism rules → write the design-stable documents.

**Files affected.**
```
smartdialer/package.json          smartdialer/tsconfig.json
smartdialer/eslint.config.js      smartdialer/vitest.config.ts
smartdialer/.env.example          smartdialer/.gitignore
smartdialer/ARCHITECTURE.md       smartdialer/CONSTRAINTS.md
smartdialer/DECISIONS.md          smartdialer/HANDOVER.md
smartdialer/BUG.md                smartdialer/ROLLBACK.md
smartdialer/FEATURE.md            smartdialer/FLOW.md
smartdialer/TEST_CHECKLIST.md     smartdialer/README.md
```

**Tests added.** None — this milestone produces no application code. The verification is
that the toolchain itself runs.

**Verification performed.**
* `node b.ts` importing `./a.ts` → printed `type-stripping works, x = 42`. Confirms D-005.
* `node -e` conditional `UPDATE` on `node:sqlite` → `changes: 1` then `changes: 0`.
  Confirms the atomic reservation primitive underpinning D-002.
* `npm install` → 190 packages, 0 vulnerabilities, all versions resolved as intended.
* `npx eslint eslint.config.js vitest.config.ts` → exit 0.

**Known limitations.** `FLOW.md`, `TEST_CHECKLIST.md` and `README.md` are honest skeletons
at this point; they are filled in as the code they describe comes into existence, rather
than being written speculatively.

**Follow-up work.** Milestone 2.

---

## F-001 — Deterministic execution core

**Status:** Done (Milestone 2)

**Problem.** Two requirements that look contradictory: simulations must replay identically
and run in milliseconds, while the dashboard must show a campaign progressing in real time.
Solving them separately would mean two implementations that drift apart, and a green test
would stop being evidence about what a user sees.

**Requirements.** One clock, injectable everywhere. Seeded randomness that survives new
consumers being added. Synchronous event dispatch so a violation surfaces where it happened.

**Implementation.** `SimulatedClock` with a `(dueTime, insertionSeq)` binary heap, driven
either by `FastDriver` (drains the queue, yielding to the runtime so async work keeps up) or
`PacedDriver` (advances against real time, scaled). `SeededRandom` with named sub-streams.
See D-003, D-004.

**Files.** `src/core/clock.ts`, `rng.ts`, `event-bus.ts`, `state-machine.ts`, `errors.ts`,
`ids.ts`, `logger.ts`, `redact.ts`, `src/config/index.ts`.

**Tests.** 20 clock, 15 RNG, 10 event-bus, 9 state-machine, 14 config, 18 core-utils.

**Verification.** `tests/simulation/simulation.test.ts` runs the same seed twice and compares
a SHA-256 digest of the ordered event stream — they match, and a different seed differs.

**Known limitations.** Wall-clock time is genuinely unavailable to engine code; anything
needing it must take a documented, reviewable ESLint override.

---

## F-002 — Concurrency and safety

**Status:** Done (Milestone 5)

**Problem.** A dialer must never exceed its limits, must never call a DNC contact, and must
be able to explain why it is not dialing.

**Implementation.** `ConcurrencyService` issues idempotent leases acquired synchronously
across all three scopes (D-008). `SafetyEngine` is one ordered list of named rules returning
an explainable decision (D-009). Denials are classified as backpressure or intervention
(D-014). `RetryService` classifies failures and computes jittered exponential backoff.

**Files.** `src/services/concurrency.ts`, `safety.ts`, `retry.ts`, `rate-limiter.ts`,
`invariants.ts`.

**Tests.** 25 concurrency (races, double-release, lease reclamation), 34 safety, 18 retry,
12 rate-limiter.

**Verification.** Live: emergency stop engaged mid-campaign produced zero new calls; 4 DNC
contacts received 0 calls; `GET /api/system/invariants` returned `PASSED`.

**Known limitations.** Single-process only (D-007). Two dialer processes against one database
would each keep their own counters and collectively exceed the global limit.

---

## F-003 — Dialing strategies

**Status:** Done (Milestone 6)

**Problem.** Pacing is the part of a dialer most likely to be subtly wrong and the part most
entangled with live state.

**Implementation.** Both strategies are pure functions of an immutable snapshot (D-010).
Predictive paces on mean-plus-variance rather than expectation (D-013), with a blended
answer-rate estimate, bounded occupancy feedback, and gradual abandon-rate degradation.

**Files.** `src/dialer/strategy.ts`, `progressive.ts`, `predictive.ts`.

**Tests.** 46 pacing unit tests, no I/O required.

**Verification.** `predictive` scenario: peak concurrency 21 against 20 agents with a 0%
abandon rate. `predictive-small-team`: paced down to 5, zero abandoned.

**Known limitations.** A small predictive team is paced to roughly 1:1 — correct, but it
looks like the feature not working. Documented in D-013 and demonstrated by its own scenario.

**Follow-up.** The variance guard replaced an expectation-based pacer that abandoned 26% of
answered calls (B-004).

---

## F-004 — API and live streaming

**Status:** Done (Milestone 7)

**Problem.** The dashboard needs to read live state and issue commands that do real things.

**Implementation.** Fastify with zod validation at every route; thin handlers that call one
service. SSE broadcaster fed directly from the event bus (D-006). Structured errors
translated in one place. Phone numbers restricted to the reserved fictional block.

**Files.** `src/api/server.ts`, `sse.ts`, `schemas.ts`, `routes/*.ts`, `src/index.ts`.

**Tests.** 34 API tests via `fastify.inject()`, including every invalid-configuration case
the brief calls out.

**Verification.** Live SSE stream consumed over HTTP showed the full call lifecycle. Every
control verified to do real work — see `TEST_CHECKLIST.md` rows 20–29.

**Known limitations.** No authentication or authorisation; CORS is restricted to localhost
because of it. Fine for a local prototype, listed under production considerations.

---

## F-005 — Simulation engine

**Status:** Done (Milestone 8)

**Problem.** Demonstrating and testing dialer behaviour requires running whole campaigns
under controlled conditions, quickly and reproducibly.

**Implementation.** `SimulationService` builds an isolated container per run — its own
in-memory database, clock, RNG and provider — so a chaos scenario cannot disturb live
campaigns. Reports carry the full statistic block plus `INVARIANTS: PASSED/FAILED`. Eight
predefined scenarios each assert what they claim to demonstrate.

**Files.** `src/services/simulation.ts`, `src/sim/scenarios.ts`, `scenario-cli.ts`,
`scripts/seed.mjs`.

**Tests.** 22 simulation tests, including all 8 scenarios and the determinism digest.

**Verification.** All 8 scenarios pass expectations and invariants; `npm run scenario`
exits non-zero on failure, so it is usable directly in CI.

---

## F-006 — Operational dashboard

**Status:** Done (Milestones 9–11)

**Problem.** The engine was fully verified by tests, but a dialer nobody can watch is hard to
trust and impossible to demonstrate. The dashboard has to show live state honestly and let an
operator act on it — without becoming a second, divergent implementation of the engine's logic.

**Requirements.**
* Every control performs a real action (`CONSTRAINTS.md` §5).
* The safety posture is unmissable.
* "Why is this campaign not dialing?" is answerable from the screen.
* No engine logic in the browser.

**Implementation.** React 19 + Vite, no framework beyond that (D-016). One `EventSource` owned
by the shell and shared by every view; aggregates come from polled REST rather than being
recomputed in the browser (D-017). Nine views: Dashboard, Campaigns, Campaign detail, Contacts,
Agents, Calls, Simulation, Provider, System Events.

The panel that justifies the whole surface is **"Why this many calls?"** on campaign detail —
the strategy's own `reasoning[]`, rendered verbatim. Pacing an operator cannot interrogate is
pacing they cannot trust, and the strategy already produces the explanation.

**Files.** `web/src/` — `App.tsx`, `lib/{api,events,router,hooks,format,types}.ts`,
`components/{ui,EventLog}.tsx`, `views/*.tsx`, `styles.css`; plus `vite.config.ts`.

**Tests.** 25 tests over the frontend's *logic* — campaign form validation (which mirrors the
server's zod bounds), route parsing, the API client's error handling, and the bounded event
buffer. Presentational components are deliberately not unit-tested; asserting the shape of
rendered JSX tests the test. What the components *do* is verified by driving a headless browser
against the running application and asserting each control changed **server** state
(`TEST_CHECKLIST.md` rows 39–53).

Writing those tests required extracting validation and route parsing out of the view
components, which is where they should have been anyway — and the first run found B-006, a
routing bug the browser checks had walked straight past.

**Verification (browser-driven).** Pause `54 → 54` calls then resume `54 → 102`; failure
injection moved the live provider's `timeoutRate 0 → 1` and produced 44 `call.timeout` events;
emergency stop held calls at `200 → 200` and release resumed to `250`; 8 DNC contacts received
0 calls; invariants `PASSED` throughout; 0 console errors across all nine views.

**Known limitations.** No authentication, so CORS is restricted to localhost. Presentational
components are not unit-tested (by choice, above). Event log is capped at 500 entries in memory
— the persisted-history view reaches further back.
