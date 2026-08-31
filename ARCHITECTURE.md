# ARCHITECTURE

The shape of the system. For *why* a given choice was made, see `DECISIONS.md`; for how
execution travels through it step by step, see `FLOW.md`.

---

## The one-paragraph version

A **dialer engine** wakes on a virtual clock tick, asks a **strategy** (progressive or
predictive) how many calls it should place right now, and then tries to place exactly that
many — but each individual dial has to get past a **safety engine**, claim an exclusive
lock on a **contact**, and acquire a **concurrency lease** before a **mock telecom
provider** is ever asked to create a call. The provider answers asynchronously, over time,
via events. Those events drive a **call state machine**, which allocates and releases
**agents**, feeds **metrics**, and is persisted to SQLite. Nothing in the system reads the
real clock or generates unseeded randomness, which is why a whole campaign can be replayed
identically from a seed, and why the test suite can run ten simulated minutes in
milliseconds.

---

## Layer map

```
                    ┌──────────────────────────────┐
   Browser          │   React dashboard (web/)     │
                    └───────┬──────────────┬───────┘
                       REST │              │ SSE  (one-way, server → client)
                            ▼              ▼
                    ┌──────────────────────────────┐
   Transport        │   Fastify API (src/api/)     │   zod-validated, thin:
                    │   routes + SSE broadcaster   │   no business logic lives here
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
   Application      │  Campaign / Contact / Agent  │
                    │  Call / Simulation services  │
                    └──────────────┬───────────────┘
                                   ▼
                    ┌──────────────────────────────┐
   Dialing          │       DialerEngine           │  one tick loop per running campaign
                    │            │                 │
                    │            ▼                 │
                    │   DialerStrategy (pure fn)   │  Progressive | Predictive
                    └──────────────┬───────────────┘
                                   ▼
        ┌────────────────┬─────────┴────────┬──────────────────┐
        ▼                ▼                  ▼                  ▼
  SafetyEngine    ConcurrencyService    RateLimiter       RetryService
  (ordered        (global/campaign/     (token bucket     (classify +
   rule list)      provider leases)      on the clock)     backoff)
        │                │                  │                  │
        └────────────────┴─────────┬────────┴──────────────────┘
                                   ▼
                    ┌──────────────────────────────┐
   Provider         │  TelecomProvider (interface) │  ← the only telecom boundary
   boundary         │  MockTelecomProvider         │
                    │  UnreliableMockTelecomProvider│
                    └──────────────┬───────────────┘
                                   │ asynchronous lifecycle events
                                   ▼
                    ┌──────────────────────────────┐
   Observation      │          EventBus            │
                    └──┬────────┬─────────┬────────┘
                       ▼        ▼         ▼
                 EventRepo   SSE     MetricsService
                 (SQLite)  broadcast      │
                                          ▼
                                   InvariantChecker
```

Underneath everything, and injected into almost everything:

```
src/core/  Clock (virtual time)  ·  Rng (seeded)  ·  EventBus  ·  StateMachine  ·  errors
```

---

## Module responsibilities

| Module | Owns | Must not |
|---|---|---|
| `src/core/` | Virtual time, seeded randomness, event dispatch, the generic state-machine helper, structured errors, invariant assertions | Know anything about dialing, campaigns or telephony |
| `src/domain/` | Entity types and the four state machines (Call, Agent, Campaign, Contact) | Perform I/O |
| `src/db/` | Schema, migrations, repositories. **The only place SQL exists.** | Contain business rules |
| `src/providers/` | The `TelecomProvider` interface and both mock implementations | Leak provider types past the interface |
| `src/dialer/` | How many calls to place (pure functions) | Place calls itself, or touch the database |
| `src/services/` | Orchestration: campaigns, calls, agents, concurrency, safety, retry, metrics, simulation | Import from `src/api/` |
| `src/api/` | HTTP shape, validation, SSE transport | Contain business logic |
| `web/` | Rendering server-computed state, and issuing commands | Compute dialer state locally |

The dashboard deserves one note of its own. It holds **one** `EventSource` in the app shell,
shared by every view, and takes aggregates (metrics, rates, occupancy) from polled REST rather
than deriving them from the event stream. Deriving them would duplicate `MetricsService` in the
browser, and the duplicate would diverge invisibly — both versions looking equally plausible.
The stream carries transitions; the endpoints carry truth (D-017).

---

## Data ownership

Two stores, with a deliberate split of authority (see `DECISIONS.md` D-007):

**SQLite is authoritative for** durable entity state — campaigns, contacts, agents, calls,
call attempts, events, simulation runs. Critically, it is authoritative for **contact
reservation**: claiming a contact is a single conditional `UPDATE ... WHERE status='READY'`
whose `changes` count decides the winner.

**In-memory counters are authoritative for concurrency** — the live count of active calls
per scope, and the lease ledger. They must be readable and mutable *synchronously* within a
single turn of the event loop, which a durable store cannot guarantee. This is sound because
the prototype is explicitly single-process; `DECISIONS.md` records what would change if it
were not.

---

## The three boundaries that matter

### Provider boundary — `src/providers/telecom-provider.ts`

The only place the system talks about telephony vendors. Everything above it deals in
`ProviderCallHandle` and `ProviderEvent`. This is what makes the system demonstrable with
zero telecom risk, and what a real integration would slot into later.

### Concurrency boundary — `src/services/concurrency.ts`

Every call that will exist must first hold a **lease**. Leases are acquired synchronously
across all three scopes (global, campaign, provider) atomically — all or nothing — and
released exactly once. No other module may increment or decrement a capacity counter.

### Safety boundary — `src/services/safety.ts`

A single ordered list of named rules. There is no path from a strategy's decision to a
provider call that does not pass through `SafetyEngine.evaluate()`, and its answer is an
explainable object (`{ allowed, code, message, metadata }`) rather than a boolean, so that
"why is this campaign not dialing?" is answerable from the UI.

---

## Event flow

Events are the system's nervous system: they are simultaneously the audit log, the UI feed,
the metrics source, and the correctness check.

```
state transition  ──▶  EventBus.emit(event)
                          │
        ┌─────────────────┼─────────────────┬────────────────────┐
        ▼                 ▼                 ▼                    ▼
   EventRepo         SSE broadcaster   MetricsService     InvariantChecker
   (batched per      (live dashboard)  (rolling windows,  (throws in tests,
    tick, one txn)                      answer/abandon     records in sim
                                        rates)             reports)
```

Events are emitted synchronously by the producer and dispatched synchronously, so an
invariant violation surfaces at the exact transition that caused it rather than a tick
later.

---

## Time, and why there is only one clock

`SimulatedClock` is the only implementation of `Clock`. It holds a priority queue of timers
ordered by `(dueTime, insertionSeq)`. What varies is only how it is advanced:

* **`FastDriver`** drains the queue as fast as the CPU allows — used by tests and instant
  simulations. Ten minutes of campaign time takes milliseconds.
* **`PacedDriver`** advances virtual time on a real interval scaled by a speed multiplier —
  used by the live dashboard, giving visible motion at 1×–100×.

The consequence worth internalising: **the dashboard and the test suite drive the same
engine along the same code path.** A green simulation test is evidence about the behaviour
a user will see, not about a parallel test-only implementation.
