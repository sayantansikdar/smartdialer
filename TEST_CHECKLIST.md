# TEST_CHECKLIST

Executable verification. Every row records the **actual observed output**, not an
impression. "Looks good" is not a result.

> **Status: complete.** Every row has been run and its real output recorded. The dashboard
> rows were verified by driving a headless Chromium against the running application, not by
> looking at it — each one asserts that the control changed real server state.
>
> **Rows 1–12 and 30–38 now run as one command: `npm run verify`** (about 19 seconds). It
> executes every step even when an earlier one fails, because "typecheck failed" and
> "typecheck failed *and* four scenarios regressed" call for different responses. Exit code is
> non-zero on any failure, so it is usable directly in CI.

Re-run the whole list after any rollback (`ROLLBACK.md`).

---

## Setup

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 1 | `npm install` | Dependencies resolve, no peer conflicts | `added 190 packages, and audited 191 packages` · `found 0 vulnerabilities` | ✅ pass |
| 2 | `node --version` | ≥ 22.12 (Vite 8/Rolldown requirement & TypeScript type stripping) | `v25.9.0` | ✅ pass |
| 3 | Node runs `.ts` directly | A `.ts` file importing another `.ts` executes | `type-stripping works, x = 42` | ✅ pass |
| 4 | `node:sqlite` conditional UPDATE is atomic | Second identical CAS reports 0 rows changed | `first reserve changes: 1` · `second reserve changes: 0` | ✅ pass |

## Static checks

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 5 | `npm run typecheck` | exit 0, strict mode | exit 0, no diagnostics | ✅ pass |
| 6 | `npm run lint` | exit 0 across `src/`, `tests/`, `scripts/` | exit 0, no findings | ✅ pass |

## Test suites

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 7 | `npm run test:unit` | Clock ordering, RNG streams, pacing maths, backoff, safety rules, state transitions, rate limiter, config | `Tests 220 passed (220)` | ✅ pass |
| 8 | `npm run test:integration` | Repositories, engine end-to-end, providers, API via `inject()`, id recovery | `Tests 154 passed (154)` | ✅ pass |
| 9 | `npm run test:concurrency` | Slot races, double contact reservation, double agent assignment, release races, lease reclamation | `Tests 25 passed (25)` | ✅ pass |
| 10 | `npm run test:failure` | Timeout, silence, stuck ringing, outage, retry exhaustion, invalid number, DNC, pause and emergency stop mid-dial | `Tests 25 passed (25)` | ✅ pass |
| 11 | `npm run test:simulation` | Seeded aggregate behaviour, all 8 scenarios, determinism digest | `Tests 22 passed (22)` | ✅ pass |
| 11b | `npm run test:web` | Frontend logic: form validation, route parsing, API error handling, bounded event buffer | `Tests 25 passed (25)` | ✅ pass |
| 12 | `npm test` | Everything, both projects | `Test Files 20 passed (20)` · `Tests 471 passed (471)` · `Duration 5.75s` | ✅ pass |

## Database and boot

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 13 | `npm run db:reset` | Database deleted and rebuilt | `Reset ./data/smartdialer.db and applied 1 migration(s).` | ✅ pass |
| 14 | `npm run db:migrate` | Migrations applied and recorded | `Applied 1 init` · `Applied 1 of 1 migration(s) → ./data/smartdialer.db` | ✅ pass |
| 15 | `npm run db:migrate` (again) | Idempotent | `Database is up to date (1 migration(s) already applied).` | ✅ pass |
| 16 | `npm run seed` | Campaigns, agents, contacts incl. DNC and prior attempts | 3 campaigns: Progressive READY (5 agents, 50 contacts, 4 DNC), Predictive READY (20 agents, 200 contacts, 8 DNC), Draft (3 agents, 25 contacts, 3 DNC) | ✅ pass |
| 17 | `node src/index.ts` | Boots, prints safety posture | `SmartDialer → http://127.0.0.1:3000` · `SIMULATION MODE — mock provider "mock". No real calls are placed.` | ✅ pass |
| 18 | `curl -s localhost:3000/api/health` | JSON health incl. simulation mode | `{"status":"ok","simulationMode":true,"providerDriver":"mock","virtualTime":69000}` | ✅ pass |
| 19 | Restart against a seeded database | No id collisions (regression for B-005) | Server boots and dials; previously `UNIQUE constraint failed: events.id` | ✅ pass |

## Live behaviour (server running, seeded)

Exercised against the real HTTP API, not through the test harness.

| # | Check | Expected | Actual | Status |
|---|---|---|---|---|
| 20 | `POST /api/campaigns/camp_000001/start` | 200, campaign RUNNING | `200 RUNNING` | ✅ pass |
| 21 | `GET /api/events/stream` | SSE frames arrive as calls progress | Received `call.dialing`, `call.ringing`, `call.answered`, `agent.reserved`, `agent.busy`, `call.completed`, `agent.available`, `retry.scheduled` | ✅ pass |
| 22 | Campaign metrics after 3s | Calls placed and answered | `total: 12, answered: 2, active: 5` | ✅ pass |
| 23 | Live pacing explanation | Human-readable reasoning | `2 available agent(s) x lineRatio 1 = 2 line(s) \| minus 1 call(s) already in flight = 1` | ✅ pass |
| 24 | `POST /api/system/emergency-stop` then wait 3s | **No new calls initiated** | `before 12, after 12` — none | ✅ pass |
| 25 | `GET /api/campaigns/:id/safety` while stopped | Explains the denial | `EMERGENCY_STOP` | ✅ pass |
| 26 | `POST /api/system/emergency-resume` | Dialing restarts | calls went 12 → 25 | ✅ pass |
| 27 | `POST /api/providers/mock-provider/config {timeoutRate:1}` | Provider genuinely goes silent; watchdog fires | `call.timeout: 3`, `provider.timeout: 3`, `retry.scheduled: 3`, agents released | ✅ pass |
| 28 | `GET /api/system/invariants` | All invariants hold | `PASSED` | ✅ pass |
| 29 | DNC contacts vs placed calls | Zero calls to DNC contacts | 4 DNC contacts, 0 calls to them | ✅ pass |

## Scenarios

Each runs the real engine and prints `INVARIANTS: PASSED/FAILED` plus whether it demonstrated
what it claims. `npm run scenario -- <name>` exits non-zero on failure, so this is usable in CI.

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 30 | `npm run scenario -- progressive` | Paced to agent availability, no abandonment | `EXPECTATIONS: PASSED` · `INVARIANTS: PASSED` · peak concurrency 5 = agent count, 0 abandoned | ✅ pass |
| 31 | `npm run scenario -- predictive` | Over-dials beyond agent count, limits authoritative | `PASSED` · peak 21 > 20 agents, abandon rate 0.0%, 200/200 contacts processed | ✅ pass |
| 32 | `npm run scenario -- predictive-small-team` | Paces down to ~1:1 rather than abandoning | `PASSED` · peak 5, 0 abandoned (see D-013) | ✅ pass |
| 33 | `npm run scenario -- provider-fail` | Slots released, transient retried, permanent not | `PASSED` · 99 attempts, 49 retries, 19 exhausted | ✅ pass |
| 34 | `npm run scenario -- timeout` | Watchdog fires, resources released, no deadlock | `PASSED` · 26 timeouts, 28 retries scheduled | ✅ pass |
| 35 | `npm run scenario -- emergency-stop` | No new calls after stop engages | `PASSED` | ✅ pass |
| 36 | `npm run scenario -- dnc` | Zero calls to DO_NOT_CALL contacts | `PASSED` · 12 contacts remained `DO_NOT_CALL` | ✅ pass |
| 37 | `npm run scenario -- race` | `activeCalls <= limit` at all times under many workers | `PASSED` · peak concurrency 12 = configured limit, never exceeded | ✅ pass |
| 38 | Same seed twice | Byte-identical event-stream digest | SHA-256 over the ordered event stream matched; different seed differed | ✅ pass |

## Dashboard verification

Driven by a headless browser against the running app. Each row asserts that a UI control
changed **real server state**, because a control that only shows a toast is a defect
(`CONSTRAINTS.md` §5).

| # | Check | Expected | Actual | Status |
|---|---|---|---|---|
| 39 | Dashboard loads and connects | Page renders, SSE reports live | title `SmartDialer`, 8 nav items, connection `Live`, 4 stat tiles, 3 campaigns, **0 console errors** | ✅ pass |
| 40 | Safety banner is prominent | Simulation mode stated above everything | `SIMULATION MODE — mock provider "mock". No real calls are placed…` | ✅ pass |
| 41 | Start a campaign from the UI | Server reports RUNNING, calls begin | status `RUNNING`, calls placed within seconds | ✅ pass |
| 42 | Live pacing explanation | The dialer's own arithmetic, rendered | `answer rate 32.4% … ceil(2 agents x 0.82 / 0.32) = 6 line(s) … clamped to 2 by the 1.5-sigma safety buffer` | ✅ pass |
| 43 | Pause from the UI | New dialing stops; server agrees | server status `PAUSED`; calls `54 → 54` | ✅ pass |
| 44 | Resume from the UI | Dialing restarts | calls `54 → 102` | ✅ pass |
| 45 | Failure injection from the UI | Live provider config changes | `timeoutRate 0 → 1` on the running provider | ✅ pass |
| 46 | …and the watchdog genuinely fires | `call.timeout` events appear | `0 → 44` timeout events; invariants still `PASSED` | ✅ pass |
| 47 | Emergency Stop from the UI | **Zero** new calls; banner shown | calls `200 → 200`; red banner rendered | ✅ pass |
| 48 | Campaign explains why it stopped | Denial codes surfaced | `EMERGENCY_STOP, CAMPAIGN_NOT_RUNNING` | ✅ pass |
| 49 | Release Emergency Stop | Dialing resumes | calls `200 → 250` | ✅ pass |
| 50 | DNC protection through the UI run | Zero calls to DNC contacts | 8 DNC contacts, **0** calls to them | ✅ pass |
| 51 | Run a scenario from the UI | Report with invariant verdict | `dnc` scenario → `INVARIANTS: PASSED` | ✅ pass |
| 52 | All nine views render | No blank pages, no errors | Dashboard, Campaigns, Campaign detail, Contacts, Agents, Calls, Simulation, Provider, System Events — all rendered, **0 page errors** | ✅ pass |
| 53 | `npm run build` | Typecheck (backend + web) passes, bundle emitted | `index.css 8.81 kB (gzip 2.43)` · `index.js 249.33 kB (gzip 74.28)` · built in 468ms | ✅ pass |

## One-command verification

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 54 | `npm run verify` | Every step above, in one run, non-zero exit on failure | `VERIFICATION PASSED — 19 steps in 18.8s` | ✅ pass |
| 55 | **The verifier actually detects a regression** | A deliberately introduced bug fails the run and names the assertion | Removed `- pendingConnections` from the progressive pacer (the bug that turns progressive into accidental predictive) → `VERIFICATION FAILED — 1 of 8 steps: unit tests`, naming `ProgressiveDialer > counts calls in flight against capacity` and `expected 5 to be 2`. Restored → passes again. | ✅ pass |

Row 55 matters more than row 54. A verification script that cannot fail is worse than no
script at all, because it converts an unchecked codebase into one that looks checked.

## Configuration loading

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 56 | `SIMULATION_SPEED=3` in `.env`, then `npm run dev` | The value takes effect | boot banner `Clock speed 3x`; `/api/system/status` reports `speed: 3` | ✅ pass |
| 57 | `GLOBAL_MAX_CONCURRENT_CALLS=37` in `.env` | The value takes effect | `config.limits.globalMaxConcurrentCalls === 37` | ✅ pass |
| 58 | **`SIMULATION_MODE=false` in `.env`** | Startup still refuses — the safety gate does not care where a value came from | `SMARTDIALER refused: SIMULATION_MODE_REQUIRED` | ✅ pass |
| 59 | No `.env` present | Runs on documented defaults, no error | `--env-file-if-exists` prints a notice and continues | ✅ pass |

Row 58 is the one that matters. Making `.env` live (B-007) opened a new path into
configuration, and the first thing to check about a new path into configuration is that it
cannot be used to turn the safety gate off.

## Cold start — what a new person actually experiences

Run against a clean copy of the repository: no `node_modules`, no `data/`, no `.env`, no
`web/dist`.

| # | Command | Expected | Actual | Status |
|---|---|---|---|---|
| 60 | `npm install && npm run dev` **and nothing else** | The app starts | API 200, dashboard 200, `data/` created automatically, migrations applied, invariants `PASSED`, 0 campaigns | ✅ pass |
| 61 | The full documented flow (`install` → `.env` → `db:migrate` → `seed` → `dev`) | Works, seeds 3 campaigns | 3 campaigns / 28 agents / 275 contacts / 15 DNC | ✅ pass |
| 62 | `npm run dev` with port 3000 taken | An actionable message, not a stack trace | `Port 3996 is already in use.` + suggested free port + `lsof` command | ✅ pass |
| 63 | `SIMULATION_MODE=false` in `.env` | Refuses, and says what to do | `SIMULATION_MODE_REQUIRED` + "Set SIMULATION_MODE=true in your .env to start." | ✅ pass |
| 64 | `npm run seed` while the server is running | Refuses rather than corrupting id counters | `Refusing to seed: a SmartDialer is running on 127.0.0.1:3000` + how to stop it | ✅ pass |

## Campaign reset

| # | Check | Expected | Actual | Status |
|---|---|---|---|---|
| 65 | Start a campaign again after it COMPLETED | Refused without a reset | `409 CONFLICT` | ✅ pass |
| 66 | `POST /api/campaigns/:id/reset` | Campaign READY, unsuccessful contacts restored | `200 -> READY · restored 3` | ✅ pass |
| 67 | **DNC contacts survive a reset** | Still `DO_NOT_CALL` | 4 before, 4 after — preserved | ✅ pass |
| 68 | Campaign runs again after reset | New calls placed | calls `61 → 64` | ✅ pass |
| 69 | **DNC still never dialled across both runs** | Zero calls to DNC contacts | **0** | ✅ pass |
| 70 | Invariants after a reset and a second full run | Hold | `PASSED` | ✅ pass |

Row 67 is the one that matters. DNC is a one-way door everywhere else in the system; a reset
that quietly reopened it would mean the guarantee held right up until someone pressed a button
labelled "run it again".
