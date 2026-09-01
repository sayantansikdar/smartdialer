# HANDOVER

Current-state memory for this project. Updated at the end of every meaningful session.
If you are a new developer or a new AI session, **read this file first**, then
`CONSTRAINTS.md`, then `ARCHITECTURE.md`.

---

## Status as of 2026-08-31 — complete (milestones 1–12 of 12)

Backend and dashboard are both finished and verified end to end.

### What has been completed

* **All twelve milestones.** Scaffold and docs; core primitives (virtual clock, seeded RNG,
  event bus, state machines, structured errors, validated config); SQLite persistence with
  migrations and repositories; the domain model and its four state machines; the provider
  abstraction with two mock providers; concurrency, safety, retry and rate limiting; the dialer
  engine with both pacing strategies; events, metrics and invariants; REST API and SSE; the
  simulation engine with eight scenarios; seed data; and the nine-view React dashboard.
* **471 tests across 20 files**, all passing in ~6s. Typecheck (backend and web) and lint clean.
* **A fresh clone needs only `npm install && npm run dev`.** The database directory and the
  migrations are created on first start; `db:migrate` and `seed` are conveniences, not
  prerequisites (B-008).
* **Configuration is loaded from `.env`** via Node's native `--env-file-if-exists` on every
  entry point (B-007). Before that fix the file the README told users to create did nothing.
* **`npm run verify`** runs the entire checklist — typecheck, lint, all six test suites, the
  production build, migrations, seeding and all eight scenarios — in about 19 seconds, exiting
  non-zero on any failure. Its ability to *fail* is itself verified (`TEST_CHECKLIST.md` row 55).
* **All eight scenarios** pass their own expectations *and* every invariant.
* **Verified live, twice over.** Against the HTTP API directly, and then by driving a headless
  browser against the running app — each dashboard control asserted to change real server
  state, not just to render. See `TEST_CHECKLIST.md` rows 20–53.

### What is currently being worked on

Nothing. The project is at a complete, verified checkpoint.

### What remains

Nothing required.

* **CI is written but dormant.** `.github/workflows/ci.yml` calls `npm run verify`. GitHub only
  reads workflows from the repository root, and this project is a subdirectory of a
  multi-project workspace (D-001) — so it activates the moment the project is split out, and
  does nothing before then. `npm run verify` covers the same ground locally.
* **Rendering is still not unit-tested**, deliberately. Frontend *logic* is (25 tests); its
  components are verified by driving a real browser. Asserting the shape of rendered JSX would
  test the test.
* Anything under "Would require production infrastructure" in `README.md`.

### What is broken

Nothing known. Five bugs were found and fixed during development — B-001 through B-005 — each
with a regression test. See `BUG.md`.

### What should not be changed

* **`SIMULATION_MODE=true` startup refusal, the absence of any real-telecom adapter, and the
  `+1-555-01xx` phone-number guard in `src/api/schemas.ts`.** These are why this repository is
  safe to run.
* **The ESLint determinism rules.** Disabling them silently breaks reproducibility (D-011). The
  three `eslint-disable` comments in `src/services/simulation.ts` are deliberate and documented:
  they measure the run from outside it.
* **The variance guard in `src/dialer/predictive.ts`.** Removing it restores a 26% abandonment
  rate (B-004). If predictive pacing looks too timid on a small team, that is the correct
  answer, not a bug — see D-013.
* **`InvariantChecker`'s ledger-versus-database comparison.** The single highest-value check in
  the suite; it is what caught B-001.
* **The dashboard polling aggregates rather than deriving them from the event stream** (D-017).
  Recomputing metrics in the browser would duplicate `MetricsService` and drift from it
  invisibly.

### What the next session should do

Nothing is outstanding. If you are picking this up to extend it: read `src/core/clock.ts`,
then `src/services/safety.ts`, then `#attemptDial` in `src/services/dialer-engine.ts` — those
three explain most of the design. Run `npm run scenario -- predictive` to see the engine work,
and `npm run dev` to watch it.

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
