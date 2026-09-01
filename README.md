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

## 🌐 Live Web Dashboard

You can explore the interactive dashboard online directly via GitHub Pages:
👉 **[https://sayantansikdar.github.io/smartdialer/](https://sayantansikdar.github.io/smartdialer/)**

*(To drive real simulation state and control backend campaigns, follow the local run guide below.)*

---

## 🚀 How to Run Locally (Step-by-Step Guide)

### 1. Prerequisites
- **Node.js**: `v22.12.0` or newer (check with `node --version`).
- **npm**: `v10.0.0` or newer (check with `npm --version`).

### 2. Clone and Install
```bash
# Clone the repository
git clone https://github.com/sayantansikdar/smartdialer.git
cd smartdialer

# Install dependencies (zero native build dependencies required)
npm install
```

### 3. Initialize Demo Data
Populate the local SQLite database with pre-configured demo campaigns, 28 agents, and 275 realistic test contacts (including Do-Not-Call entries):
```bash
npm run seed
```

### 4. Launch the Application
Start both the backend simulation engine and the live web dashboard supervisor:
```bash
npm run dev
```

The terminal will display the active services:
- **Web Dashboard**: [http://localhost:5173](http://localhost:5173)
- **API Server**: [http://127.0.0.1:3000](http://127.0.0.1:3000)

### 5. Optional Tuning (`.env`)
You can adjust the clock speed and engine parameters by creating a `.env` file (loaded natively by Node — no dependencies):
```bash
cp .env.example .env
```
Key settings:
- `SIMULATION_SPEED=3`: Slower speed (3× real-time), ideal for watching individual call state transitions live.
- `SIMULATION_SPEED=10`: Default speed (10× real-time), completes a 50-contact campaign in ~1 minute.

---

## 🎮 Interactive Client Demo & Walkthrough

Follow this step-by-step tour to test and evaluate the system's core capabilities directly from the dashboard:

### 1. Progressive Dialing (Guaranteed Zero Abandonment)
1. Open **[http://localhost:5173](http://localhost:5173)** and navigate to the **Campaigns** tab in the sidebar.
2. Click **Start** on **"Q3 Renewals (Progressive)"** (5 agents, 50 contacts).
3. Click on the campaign name to open its detail page.
4. Observe the live **"Why this many calls?"** decision box:
   - Progressive dialing places **strictly 1 call per free agent**.
   - As agents answer calls, available capacity decreases and new dials pause.
   - **Result**: Exactly 0 abandoned calls — every answered customer reaches an available agent immediately.

### 2. Predictive Dialing (High-Throughput Over-Dialing with Variance Guard)
1. In the **Campaigns** tab, click **Start** on **"New Product Outreach (Predictive)"** (20 agents, 200 contacts).
2. Open the campaign detail page and examine the real-time calculation:
   - The engine computes the moving answer rate (e.g., ~50%) and **over-dials** (e.g., placing 30+ simultaneous calls for 20 seats).
   - Notice the **Variance Guard** in action: rather than betting purely on averages, it reserves a safety margin for statistical fluctuations (`Lp + 1.5·√(Lp(1-p)) ≤ seats`).
   - Peak concurrency safely exceeds the agent seat count while the abandon rate remains near zero.

### 3. Simulating Telecom Outages & Watchdog Recovery
1. Navigate to the **Provider** tab in the sidebar.
2. Click **"All calls go silent"** (or increase the simulated network error rate).
3. The mock telecom provider will now accept calls but deliberately drop all completion signals.
4. Watch the dashboard's **Event Log** and **Calls** tab:
   - In ~45 seconds of virtual time, the dialer's internal watchdog detects the dead calls.
   - `call.timeout` events fire, concurrency slots and stuck agents are **automatically released**, and retries are scheduled with exponential backoff.
   - **The system never deadlocks or leaks capacity.**

### 4. Global Emergency Stop (Kill Switch)
1. Click the red **Emergency Stop** button in the top navigation bar.
2. Active campaigns pause instantly:
   - No new dials are initiated across any campaign.
   - Ongoing in-flight calls finish gracefully.
   - Campaign detail pages immediately display `EMERGENCY_STOP` explainability banners.
3. Click **Release Emergency Stop** to resume normal operation.

### 5. Automated Scenario Testing & Invariant Verification
1. Navigate to the **Simulation** tab in the sidebar.
2. Select any scenario from the dropdown:
   - `predictive`: Demonstrates safe over-dialing and limit enforcement.
   - `timeout`: Demonstrates silent provider watchdog recovery.
   - `dnc`: Formally proves **zero calls** are placed to `DO_NOT_CALL` contacts.
   - `race`: Stress tests high-concurrency worker races.
3. Click **Run Scenario** to execute the simulation in milliseconds and review the formal `INVARIANTS: PASSED` verdict report.

---

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
npm run verify             # everything below, plus build + all 13 scenarios
npm run load               # scaling measurement — see SCALE.md
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
