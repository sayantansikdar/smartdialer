# HANDOVER

Current-state memory for this project. Updated at the end of every meaningful session.
If you are a new developer or a new AI session, **read this file first**, then
`CONSTRAINTS.md`, then `ARCHITECTURE.md`.

---

## Status as of 2026-09-01 — aligned to the assignment brief

Backend, dashboard and the assignment's specific requirements are all in place. One known
open issue (B-015), characterised and contained rather than hidden.

### What changed most recently

Audited against `Tech Assignment - Hiring 2026.pdf` and closed the real gaps:

* **Safety Controller** (`src/dialer/safety-controller.ts`) — the brief's "important part".
  Pacing engines now produce a *request* and can no longer clamp themselves; the controller is
  the only path to an approved count, with four verdicts including `FALLBACK_PROGRESSIVE`
  (D-018).
* **Duplicate and out-of-order provider events** — `UnreliableMockTelecomProvider` now
  duplicates and reorders on purpose, and the engine survives it (D-020). Found B-010: three
  duplicate ANSWERED events were reserving three agents.
* **Worker-crash recovery** (`src/services/recovery.ts`) — reconciles orphaned calls, contacts
  and agents at startup (D-019).
* **Scenarios A/B/C/D and agent-drop** — the brief's pacing table, plus 30 of 40 agents
  vanishing mid-run.
* **Load test and `SCALE.md`** — measured, not asserted. Found and largely fixed B-016.
* **`ANSWER.md`** — the brief's final question.

### Bugs found and fixed this session

B-010 (duplicate events reserved multiple agents), B-011 (abandon rate reported 0% while 29
were abandoned), B-012 (watchdog killed every call over 45s), B-013 (abandon control fired 13
abandons late), B-014 (abandonments logged twice), B-016 (reservation query sorted the whole
campaign per attempt — 722µs → 17.9µs, now flat).

### What is broken

**B-015 is open.** Predictive pacing abandons ~13–20% in the long-talk-time scenarios
(`pacing-a`, `pacing-c`). The safety control detects it, latches a pause and stands the
campaign down — the *guarantee* holds, the *guess* is worse than it should be. Two hypotheses
were tested by measurement and both disproved; the current best explanation and the intended
fix are in `BUG.md` B-015.

The scenario expectations deliberately assert the safety properties and **not** a low abandon
rate, because loosening a test until it passes would hide exactly this.

### What should not be changed

* The safety gate, the absence of a real-telecom adapter, the `+1-555-01xx` guard.
* **The pacing engines' inability to reach a limit** (D-018). The tests that assert they import
  nothing but their own interface are structural, not cosmetic.
* `#transitionCall`'s return value must be honoured by every caller (D-020, B-010).
* `#settle` must verify reachability *before* committing (B-010).
* The covering index in `migrations/002` — it is worth 40× at 1,500 agents (B-016).

### What the next session should do

Either B-015 (model time-to-free-seat rather than instantaneous free seats) or the next
scaling term named in `SCALE.md` (per-attempt agent counting). Both have measurement harnesses
already: `pacing-a`..`pacing-d` and `npm run load`.

## Verified environment facts

Do not re-derive these; they were checked directly on this machine.

| Fact | Value |
|---|---|
| Node | v25.9.0 (native TypeScript type stripping confirmed working) |
| npm | 11.12.1 |
| `node:sqlite` | Present. Conditional `UPDATE` verified atomic: `changes: 1` then `changes: 0` |
| Resolved deps | typescript 6.0.3, eslint 10.9.1, vitest 4.1.11, vite 8.2.2, fastify 5.12.1, zod 4.5.4, react 19.2.8 |
| Gotcha | ESLint 10 does **not** bundle `@eslint/js`; it is an explicit devDependency |
| Gotcha | `eslint@^9.40.0` does not exist — the 9.x line stops lower |
| Gotcha | macOS has no `timeout` command; use a Node poll loop when waiting on the server |
| Gotcha | Piping a command through `tail` masks its exit code — use `set -o pipefail` |

## Things that are easy to get wrong here

* **The engine must never leave a perpetual timer scheduled.** `FastDriver` stops when the
  clock is idle, so a self-rescheduling timer means no simulation ever terminates. This is
  why the unreliable provider re-rolls its "weather" lazily on `createCall` rather than on
  an interval, and why the engine stands down when a campaign provably cannot dial.
* **Anything called per tick is the hot path.** Reporting aggregates are fine per request and
  never fine per tick (B-002).
* **Tests all use `:memory:` databases.** That is why B-005 — a restart-only bug — went unseen.
  `tests/integration/id-recovery.test.ts` is currently the only test that touches a real file.
* **The dashboard must not compute dialer state.** It renders what the server reports. A
  metric derived in the browser will drift from the engine's own and both will look plausible.
* **A campaign that has exhausted its contacts refuses to restart**, correctly. Several
  verification runs looked like failures until this was noticed — reseed rather than debugging
  the engine.
* **Browser automation only exercises paths someone thought to click.** The frontend test suite
  found a routing bug (B-006) on its first run, in a thirty-line module that the browser checks
  had already "verified". The two kinds of test are not substitutes.
* **Three bugs were found by *running* the app rather than testing it** — B-005 (restart id
  collision), B-006 (trailing-slash route), B-007 (`.env` never loaded). All three lived in the
  seam between a well-tested component and the way a real user reaches it. Perfectly isolated
  units cannot cover those seams; `npm run verify`'s migrate/seed/build steps exist for exactly
  this reason.

---

## Session log

### 2026-08-31 — Session 1

```
Done:          Milestone 1. Project scaffold, toolchain installed and verified, ESLint
               determinism rules active, ARCHITECTURE/CONSTRAINTS/DECISIONS written.
Remaining:     Milestones 2-12 (all application code and the dashboard).
Broken:        Nothing — no application code exists yet.
Watch out for: Backend imports need explicit `.ts` extensions (D-005). No Date.now/
               Math.random/setTimeout outside src/core/clock.ts — ESLint enforces this.
Next:          Milestone 2 — src/core/ primitives with unit tests.
```

### 2026-08-31 — Session 2 (Phase A checkpoint)

```
Done:          Milestones 2-8. Full backend: core primitives, persistence, domain, providers,
               concurrency/safety/retry, dialer engine with both strategies, events/metrics/
               invariants, REST API + SSE, simulation engine, 8 scenarios, seed data.
               446 tests green. Fixed B-003 (livelock), B-004 (26% abandonment),
               B-005 (id collision on restart). Verified live, not just in tests.
Remaining:     Phase B — the React dashboard (milestones 9-12) and the final README pass.
Broken:        Nothing known.
Watch out for: Predictive pacing is deliberately timid on small teams (D-013) — that is
               correct, not a bug. Never leave a perpetual clock timer scheduled.
Next:          Vite + React shell, SSE client, then the Dashboard and Campaign detail views.
```

### 2026-08-31 — Session 3 (Phase B, project complete)

```
Done:          Milestones 9-12. React dashboard: nine views, one shared SSE stream, live
               pacing explanation, failure-injection panel, simulation runner. Final docs
               pass. Verified by driving a headless browser: every control changes real
               server state. 446 tests green; typecheck, lint and build clean.
Remaining:     Nothing required. Optional: component tests, a CI workflow.
Broken:        Nothing known.
Watch out for: The dashboard renders server-computed state and must keep doing so (D-017).
               Predictive pacing is deliberately timid on small teams (D-013).
Next:          Nothing outstanding. To extend: read clock.ts, safety.ts, then #attemptDial.
```

### 2026-08-31 — Session 4 (frontend tests, one-command verification)

```
Done:          Closed the project's last asymmetry — the web layer had 20 files and no tests.
               Extracted campaign validation and route parsing into testable modules, added
               25 frontend logic tests (471 total). Added `npm run verify` (whole checklist,
               19s) and proved it detects an injected regression. Added a dormant CI workflow.
               Fixed B-006, found by the first frontend test run.
Remaining:     Nothing required.
Broken:        Nothing known.
Watch out for: CI is dormant until the project is split into its own repo — `npm run verify`
               is the working equivalent today.
Next:          Nothing outstanding.
```

### 2026-09-01 — Session 6 (made it completely runnable)

```
Done:          Cold-start tested from a clean copy and fixed what it exposed. B-008: a fresh
               clone could not start because `data/` did not exist — the Database now creates
               it, so `npm install && npm run dev` is now genuinely all that is required.
               B-009: a COMPLETED campaign was a dead end — added reset (API + UI) that
               restores unsuccessful contacts but never DNC and never the already-reached.
               Actionable messages for port-in-use and the safety refusal. Guarded seed and
               db:reset against running behind a live server. 478 tests; verify 19/19.
Remaining:     Nothing required.
Broken:        Nothing known.
Watch out for: Reset must never restore DO_NOT_CALL. That is the highest-value assertion in
               tests/failure/campaign-reset.test.ts — do not weaken it.
Next:          Nothing outstanding.
```

### 2026-09-01 — Session 5 (ran the app)

```
Done:          Launched with `npm run dev` and drove it in a browser. Found and fixed B-007 —
               the `.env` the README tells you to create was never read, so every setting in
               it was silently ignored. Fixed with Node's native --env-file-if-exists on all
               six entry points; no dependency added. Confirmed the safety gate still refuses
               SIMULATION_MODE=false through the newly-live path.
Remaining:     Nothing required.
Broken:        Nothing known. verify: 19/19 in 17.7s.
Watch out for: Seeded campaigns have finite contacts — a COMPLETED one will not restart. Run
               `npm run db:reset && npm run seed` for a fresh demo.
Next:          Nothing outstanding.
```

### 2026-09-01 — Session 7 (assignment alignment)

```
Done:          Audited against the assignment PDF. Added the Safety Controller (pacing can no
               longer clamp itself), duplicate/out-of-order event handling, worker-crash
               recovery, scenarios A-D + agent-drop, load test and SCALE.md, ANSWER.md.
               Fixed B-010 through B-014 and B-016. 513 tests, 13/13 scenarios, verify green.
Remaining:     B-015 — predictive over-abandons with long talk times. Characterised, contained
               by the safety control, not solved.
Broken:        Nothing that breaches a guarantee. B-015 is a pacing-quality issue.
Watch out for: Do not "fix" B-015 by loosening the scenario expectations. They assert safety
               properties on purpose.
Next:          B-015 (time-to-free-seat model) or the next scaling term in SCALE.md.
```
