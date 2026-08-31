# CONSTRAINTS

Hard boundaries for this repository. These are not preferences. A change that violates one
of these is wrong even if it passes tests, and should be rejected in review.

Each constraint says **how it is enforced**, because a constraint that lives only in prose
decays. Where the enforcement column says "convention", that is an honest admission that
only review catches a violation.

---

## 1. Safety

The single most important property of this repository: **it cannot place a real phone call.**

| Constraint | Enforcement |
|---|---|
| Never place a real call | No real-telecom code exists in the repo. `ProviderRegistry` can only construct `mock` and `unreliable-mock`. |
| Never contact a real phone number | Seed and simulation data use the reserved `+1-555-01xx` range (NANP fictional block). |
| Never expose a production telecom credential | No credential fields exist in config. Nothing to leak. |
| Mock providers are the default | `PROVIDER_DRIVER` defaults to `mock`; any unknown value fails startup. |
| Simulation mode cannot be left implicitly | Startup **refuses to boot** unless `SIMULATION_MODE=true`. |
| Real-provider support stays disabled | If a real adapter is ever added it must be opt-in, off by default, and gated behind a second explicit acknowledgement flag. It is not present today. |
| Safety controls cannot be bypassed | Every dial passes `SafetyEngine.evaluate()`. There is no code path from a dialer strategy to `provider.createCall()` that skips it. |
| Concurrency limits cannot be bypassed | Slots are acquired from `ConcurrencyService` before the provider is called. |

**Why the startup refusal exists:** a `.env` copied from somewhere else, or an environment
variable left over from another service, is exactly how a "prototype" ends up dialling.
Requiring an explicit affirmative makes the safe state the only reachable state.

---

## 2. Determinism

The prototype claims that a simulation replays identically from its seed. That claim is
load-bearing — the test suite depends on it — so it is enforced mechanically.

| Constraint | Enforcement |
|---|---|
| No wall-clock time in engine code | ESLint `no-restricted-syntax` bans `Date.now()` and `new Date()` outside `src/core/clock.ts`. |
| No real timers in engine code | ESLint bans `setTimeout` / `setInterval` outside `src/core/clock.ts` and `scripts/`. |
| No unseeded randomness anywhere | ESLint bans `Math.random()` repo-wide. Use `Rng`. |
| Iteration order must be stable | Never iterate a `Set`/`Map` whose insertion order depends on async completion order when the result feeds a decision. Sort by id first. *(convention)* |
| Timer ties must break deterministically | `SimulatedClock` orders by `(dueTime, insertionSeq)`, never by insertion into a hash structure. |

---

## 3. Engineering

| Constraint | Enforcement |
|---|---|
| TypeScript strict mode | `strict: true` plus `noUncheckedIndexedAccess` in `tsconfig.json`. |
| Only erasable TypeScript syntax | `erasableSyntaxOnly: true`. The backend runs under Node's native type stripping — enums, namespaces and parameter properties would typecheck and then crash at runtime. Use `const` objects + union types instead of enums. |
| No unnecessary dependencies | Runtime deps are `fastify` and `zod`, and nothing else. Adding one requires a `DECISIONS.md` entry stating what it replaces. |
| No hidden global mutable state | State is owned by explicitly constructed services, wired in one composition root (`src/container.ts`). No module-level mutable singletons. *(convention)* |
| Business logic testable without HTTP/UI | Nothing under `src/services/`, `src/dialer/`, `src/domain/` or `src/core/` may import from `src/api/`. *(convention)* |
| Provider code stays behind the adapter | Nothing outside `src/providers/` may import a concrete provider class; consumers take `TelecomProvider`. *(convention)* |
| Database access stays behind repositories | SQL appears only in `src/db/`. Services take repository interfaces. *(convention)* |
| Configuration is explicit | All config flows from `src/config/index.ts`, parsed and validated once at startup. No `process.env` reads elsewhere. *(convention)* |
| No silent failures | Every `catch` either handles intentionally, rethrows, or records an event. An empty catch is a bug. *(convention)* |
| Important state transitions are observable | State machines emit an event on every transition; invalid transitions throw `InvalidTransitionError`. |

---

## 4. Correctness invariants

These must hold at every observable moment. `InvariantChecker` asserts them; in tests it
throws, in simulation runs it records a violation into the report.

```
activeCalls                  <= GLOBAL_MAX_CONCURRENT_CALLS
campaign.activeCalls         <= campaign.maxConcurrentCalls
provider.activeCalls         <= PROVIDER_MAX_CONCURRENT_CALLS
agents in ON_CALL            <= number of agents
contacts with an active call <= 1 per contact
active calls per agent       <= 1
contact.attemptCount         <= campaign.maxAttemptsPerContact
```

Plus these behavioural invariants:

```
a contact marked DO_NOT_CALL is never dialled
a campaign in STOPPED/COMPLETED/DRAFT never initiates a call
while emergency stop is engaged, no call is initiated
every acquired concurrency lease is eventually released
```

---

## 5. AI development discipline

* Do not make changes unrelated to the task at hand.
* Do not rewrite a working module because a different structure would be tidier.
* Do not add a dependency without recording why in `DECISIONS.md`.
* Do not change architecture without a `DECISIONS.md` entry.
* Do not mark work complete without tests.
* **Do not claim tests passed without running them and reading the output.**
* Update `HANDOVER.md` at the end of every session.
