# DECISIONS

Architectural and implementation decisions a future engineer might otherwise have to
re-litigate. Trivial choices are deliberately absent.

**AI contributor on all entries below:** Claude Opus 5 (`claude-opus-5`), via Claude Code.
Recorded per the traceability requirement — model behaviour changes across versions, and a
decision is easier to re-examine when you know what produced it.

---

## D-001 — SmartDialer lives as a self-contained subdirectory of the workspace repo

**Date:** 2026-08-31

**Context.** `~/Developer` is a personal multi-project git repository holding `career-ops/`,
`a-missing-world/` and `sayantansikdar/` — unrelated projects sharing one history. It also
had 209 pending staged changes at the time this work started.

**Options considered.** (a) Self-contained subdirectory in the existing repo. (b) Separate
repository with `git init`, the way `a-missing-world` was split out. (c) Somewhere outside
the workspace entirely.

**Chosen.** (a) — `smartdialer/` with its own `package.json`, tests and documentation.

**Reason.** It matches how the workspace already organises projects, keeps the prototype
visible alongside the user's other work, and requires no repository setup. The pending
staged changes are untouched by anything under `smartdialer/`.

**Tradeoffs.** The prototype's history is interleaved with unrelated workspace commits.
If it outgrows prototype status, splitting it out later is cheap (one `git subtree split`).

**Consequences.** All paths in the documentation are relative to `smartdialer/`. The
project's `.gitignore` is local to it.

---

## D-002 — Persistence uses Node's built-in `node:sqlite`

**Date:** 2026-08-31

**Context.** The prototype needs durable storage for campaigns, contacts, calls, attempts
and events, plus an atomic primitive for claiming a contact.

**Options considered.** (a) `node:sqlite` (built into Node ≥22.5). (b) `better-sqlite3`.
(c) Drizzle or Prisma over SQLite.

**Chosen.** (a) `node:sqlite`.

**Reason.** Three properties, in order of importance:

1. **It is synchronous.** This is not a convenience, it is the correctness argument. A
   contact is claimed by `UPDATE contacts SET status='RESERVED' WHERE id=? AND status='READY'`
   and inspecting `changes`. Because the call is synchronous and Node is single-threaded,
   no other worker can interleave between the read and the write — the check-and-set is
   genuinely atomic. An async driver would introduce an `await` in exactly the place that
   must not have one. *(Verified experimentally before adoption: first call returned
   `changes: 1`, second returned `changes: 0`.)*
2. **Zero dependencies and no native build step**, so `npm install` cannot fail on a
   toolchain issue — important for a prototype meant to be handed to someone else.
3. It keeps the dependency budget for things that earn it.

**Tradeoffs.** Younger and less battle-tested than `better-sqlite3`, with a smaller API
surface and less community documentation. Requires Node ≥22.5 (this machine runs 25.9).
An ORM would have given typed schemas and generated migrations; hand-written SQL behind
repositories is more code but keeps the data layer legible and dependency-free.

**Consequences.** SQL is hand-written and confined to `src/db/`. Migrations are numbered
`.sql` files applied by a small runner. Repository interfaces are what services depend on,
so replacing the driver later touches only `src/db/`.

---

## D-003 — One simulated clock, two drivers

**Date:** 2026-08-31

**Context.** Two requirements that appear to conflict: simulations must be **deterministic
and fast** (a test cannot wait 30 real seconds for a call to complete), while the dashboard
must show a campaign progressing **in visible real time**.

**Options considered.**
(a) Real timers in production, fake timers injected in tests.
(b) A single virtual clock, advanced two different ways.
(c) A separate "simulation" engine alongside the real one.

**Chosen.** (b). `SimulatedClock` is the only `Clock` implementation. `FastDriver` drains
its timer queue immediately; `PacedDriver` advances virtual time on a real 50 ms interval
scaled by a speed multiplier.

**Reason.** Option (a) is the common approach and it is the one that quietly lies: the code
path under test differs from the code path in production, so a passing test says less than
it appears to. Option (c) is worse — two implementations that drift apart, and the demo
stops being evidence of anything. With (b), **the dashboard and the test suite drive the
same engine through the same code**, so a green simulation test is a statement about what
the user will actually see. It also makes the speed control (1×–100×) fall out for free:
it is just the multiplier on the pacing driver.

**Tradeoffs.** Every module must accept an injected `Clock` — more constructor plumbing,
and a real discipline cost. Wall-clock time is genuinely unavailable to engine code, so
anything needing a human-readable timestamp must take it from the clock's virtual epoch.
Enforcement is mechanical (ESLint, D-011) because prose would not survive.

**Consequences.** `Date.now()`, `new Date()`, `setTimeout` and `setInterval` are banned
outside `src/core/clock.ts`. Timer ties break by insertion sequence, never by hash order.

---

## D-004 — Seeded RNG with named per-consumer streams

**Date:** 2026-08-31

**Context.** Reproducibility requires seeded randomness. The naive approach — one global
seeded generator that every consumer draws from — has a failure mode that only appears
later: adding a new random consumer anywhere shifts the draw sequence for every existing
one, so previously recorded seeds stop reproducing their runs. Bug reports pinned to a seed
become worthless.

**Options considered.** (a) One global seeded stream. (b) One root seed, deriving an
independent sub-stream per named consumer. (c) A seeded-random library.

**Chosen.** (b), with `mulberry32` (about six lines — no dependency justified here).
Sub-stream seeds are a deterministic hash of `rootSeed + streamName`, e.g.
`rngFor('provider.outcome')`, `rngFor('provider.ringDuration')`, `rngFor('agent.handleTime')`.

**Reason.** Streams are independent, so adding a consumer later perturbs nobody else and
old seeds keep reproducing old runs. It also makes failures easier to reason about: ring
durations and answer outcomes are not entangled.

**Tradeoffs.** Slightly more ceremony at each call site (you must name your stream), and
stream names become part of the reproducibility contract — renaming one changes its
results.

**Consequences.** `Math.random()` is banned repo-wide by ESLint. Determinism is asserted by
a test that runs the same seed twice and compares a SHA-256 digest of the ordered event
stream, which catches accidental non-determinism anywhere in the engine, not just in RNG use.

---

## D-005 — The backend runs on Node's native type stripping; there is no build step

**Date:** 2026-08-31

**Context.** Running a TypeScript backend normally means either a compile step (`tsc` to
`dist/`) or a loader dependency (`tsx`, `ts-node`).

**Options considered.** (a) `tsc` build to `dist/`. (b) `tsx` as a dev dependency.
(c) Node 25's native type stripping — `node src/index.ts` directly.

**Chosen.** (c). *(Verified before adoption: Node 25.9 executes a `.ts` file importing
another `.ts` file by explicit extension.)*

**Reason.** One fewer dependency, no build artifacts to get stale, and the stack trace line
numbers match the source you are reading. For a prototype whose whole point is being easy
to run, inspect and debug, that last property matters more than it sounds.

**Tradeoffs.** Type stripping only erases; it cannot *transform*. So `enum`, `namespace`
and constructor parameter properties are unavailable — code using them typechecks fine and
then fails at runtime. Mitigated by setting `erasableSyntaxOnly: true`, which turns that
runtime failure into a compile error. Relative imports must carry an explicit `.ts`
extension. Requires Node ≥22.6 for the flag-free behaviour.

**Consequences.** Union types plus `const` objects replace enums throughout the domain
model (which is better practice anyway — the values are plain strings in the database).
`npm run build` only typechecks the backend and builds the frontend.

---

## D-006 — Live updates use Server-Sent Events, not WebSocket

**Date:** 2026-08-31

**Context.** The dashboard needs a live feed of events and metrics.

**Options considered.** (a) SSE. (b) WebSocket via `ws`. (c) HTTP polling.

**Chosen.** (a) SSE.

**Reason.** The traffic is entirely one-way — the server streams state, the browser issues
commands as ordinary REST calls. SSE is plain HTTP: no dependency, reconnection handled by
the browser, and the stream is `curl`-able, which makes it verifiable from the test
checklist without a browser. Polling was rejected because it cannot show a call transition
at 100× speed.

**Tradeoffs.** No client→server channel on the stream (not needed). Limited concurrent
connections per origin under HTTP/1.1 (irrelevant for a local prototype).

**Consequences.** `GET /api/events/stream` holds an open response; the broadcaster keeps a
subscriber set and must remove subscribers on close to avoid leaking.

---

## D-007 — Concurrency is in-memory-authoritative; contact reservation is database-authoritative

**Date:** 2026-08-31

**Context.** Both concurrency slots and contact ownership need mutual exclusion, and it is
tempting to put both in the same place.

**Chosen.** Split the authority. **Concurrency counters and leases live in memory.**
**Contact reservation goes through SQLite's conditional `UPDATE`.**

**Reason.** They have different requirements. A concurrency check must be synchronous and
must happen many times per tick — putting it in the database buys nothing in a single
process and costs a round trip in the hot path. Contact reservation, by contrast, must
survive a restart and is naturally expressed as a conditional update on a row that has to
be written anyway.

**Tradeoffs.** This is explicitly **a single-process design**. Two dialer processes against
one database would each maintain their own concurrency counters and would collectively
exceed the global limit — the contact lock would still hold, but capacity limits would not.

**Consequences.** Stated plainly in `README.md` under limitations. Making this
multi-process would require moving the lease ledger into the database (or a coordinator)
and accepting an async acquisition path — which would, in turn, mean the check-and-acquire
sequence needs a real transaction rather than relying on single-threaded synchrony.

---

## D-008 — Concurrency slots are idempotent lease objects, not counter decrements

**Date:** 2026-08-31

**Context.** The obvious implementation of a concurrency limit is `count++` on acquire and
`count--` on release.

**Chosen.** `acquire()` returns a `Lease` object carrying an id, its scopes, an expiry, and
a `released` flag. `release()` is idempotent; releasing twice is a no-op.

**Reason.** A bare `count--` makes **double release** silently corrupt capacity: the counter
drifts below the true number of active calls, and the system quietly begins exceeding its
limit with no error anywhere. It is the classic dialer bug and it is very hard to spot after
the fact, because the symptom (too many calls) appears far from the cause (a release path
that ran twice). A flagged object turns a double release into a no-op, and the release-race
tests target exactly this.

**Tradeoffs.** Slightly more allocation and bookkeeping than an integer.

**Consequences.** Leases carry an expiry and a watchdog reclaims expired ones, so a provider
that goes silent cannot leak a slot forever. Every lease acquisition is paired with a
release in a `finally`-style guard on every failure path.

---

## D-009 — Safety is one ordered list of named rules returning an explainable decision

**Date:** 2026-08-31

**Context.** Safety checks (emergency stop, DNC, attempt limits, three concurrency scopes,
rate limit, agent capacity, abandon rate) could each live where they are most convenient.

**Options considered.** (a) Checks scattered at their natural call sites. (b) One
`SafetyEngine` with an ordered rule array returning `{ allowed, code, message, metadata }`.

**Chosen.** (b).

**Reason.** Scattered checks cannot be audited — you can never be sure you have found them
all, and a new dialing path silently skips the ones its author forgot. A single ordered list
is *readable as a specification*: the safety policy is literally an array you can print.
Returning a structured decision rather than a boolean means the same object serves three
consumers — the log line, the emitted event, and the dashboard's "why is this campaign not
dialing?" panel. That last one turns a frustrating demo into a self-explaining one.

**Tradeoffs.** The engine needs a context object assembled per evaluation, which is
marginally more work per dial than an inline `if`.

**Consequences.** Rule order is meaningful — cheap and absolute rules (emergency stop, DNC)
come before expensive or advisory ones, so the reported reason is the most fundamental one.
Adding a control is one array entry plus one unit test.

---

## D-010 — Dialing strategies are pure functions

**Date:** 2026-08-31

**Context.** The pacing algorithms are the intellectual core of a dialer and the part most
likely to be wrong. They are also the part most entangled with live state.

**Chosen.** `DialerStrategy.computeDialPlan(snapshot) → { attempts, reasoning[] }` — a pure
function of an immutable snapshot. It performs no I/O, places no calls, and touches no
database.

**Reason.** Pacing becomes unit-testable with a literal object and no fixtures: "given 5
available agents and a 50% answer rate, ask for 10". Testing predictive pacing through a
live engine would be slow, fragile, and would confuse a pacing bug with a scheduling bug.
The `reasoning[]` array carries the arithmetic and every clamp that was applied, so both
the test output and the dashboard can explain *why* the number is what it is.

**Tradeoffs.** The engine must assemble a snapshot each tick (a small allocation), and
strategies cannot react to anything not present in the snapshot type — which is a feature:
it makes their inputs explicit.

**Consequences.** `ProgressiveDialer` and `PredictiveDialer` are independently testable and
independently replaceable. The engine owns *acting* on the plan; the strategy owns *deciding*.

---

## D-011 — Determinism is enforced by ESLint, not by convention

**Date:** 2026-08-31

**Context.** D-003 and D-004 are only true while every module obeys them. A single
`Date.now()` or `Math.random()` added later silently destroys reproducibility — and it fails
*quietly*, since the code still works, it just stops replaying.

**Chosen.** ESLint `no-restricted-syntax` bans `Date.now()`, `new Date()`, `setTimeout`,
`setInterval` and `Math.random()` in engine code, with narrow allowances: `src/core/clock.ts`
(where real time is deliberately converted to virtual time), `scripts/` (process supervision),
and `web/` (the browser renders server-computed state and has no determinism requirement).

**Reason.** A constraint whose violation is invisible needs mechanical enforcement. This one
costs nothing and fails loudly at lint time with a message pointing at the alternative.

**Tradeoffs.** Occasional friction when genuinely-real time is needed; the fix is an
explicit, reviewable override rather than a silent regression.

---

## D-012 — Dependency versions: TypeScript 6, ESLint 10

**Date:** 2026-08-31

**Context.** TypeScript 7.0.2 (the native Go port) is the current latest.

**Chosen.** `typescript@^6.0.2`, matching what `career-ops/web` in this workspace already
uses. ESLint pinned to `^10.9.1`.

**Reason.** TypeScript 7 is a compiler rewrite whose interaction with `typescript-eslint@8`
is not yet something to depend on for a project meant to be handed over. TS 6 supports
everything needed (`erasableSyntaxOnly` landed in 5.8). ESLint 10 was chosen over 9 simply
because `typescript-eslint@8.68` declares support for it and `^9.40` does not exist — the
9.x line stops lower.

**Consequences.** Revisit when `typescript-eslint` declares first-class TS 7 support.

---

## D-013 — Predictive pacing bets on variance, not on the mean

**Date:** 2026-08-31

**Context.** The textbook predictive formula balances *expected* answers against available
seats: `lines = agents x multiplier / answerRate`. Implemented that way, the prototype
abandoned 26% of answered calls on a 5-agent campaign — people picking up to silence — while
every concurrency limit was being honoured perfectly (BUG.md B-004).

**The problem with the mean.** Answers are binomial. Eight lines at a 50% answer rate average
four answers, but roughly one batch in seven produces more answers than there are agents, and
every excess answer is a real person hearing nothing. Pacing to the expected value guarantees
you overshoot about half the time.

**Options considered.** (a) Pace on expectation and rely on the abandon-rate control to catch
the damage. (b) A fixed conservative multiplier. (c) Pace so that expected answers *plus a
variance margin* fit the available seats.

**Chosen.** (c). For `L` lines at answer rate `p`, answers have mean `Lp` and standard
deviation `sqrt(Lp(1-p))`. The pacer solves `Lp + k·sqrt(Lp(1-p)) <= seats` for `L` in closed
form, with `k = 1.5` sigma.

**Reason.** (a) is what produced the bug: the abandon control is a backstop that reacts after
people have already been abandoned, and a backstop is not a policy. (b) cannot adapt — any
fixed multiplier is either too timid for a large team or too aggressive for a small one.
(c) derives the limit from the actual statistics, and produces the behaviour real predictive
dialers exhibit: **the safe over-dial ratio grows with team size.** Five seats at a 50%
answer rate permits about six lines (1.2x); twenty seats permits about thirty-one (1.55x).

**Tradeoffs.** A five-agent predictive campaign is paced down to roughly one line per agent —
essentially progressive. That looks like the feature not working, and it is worth being
explicit that it is the correct answer: a small team cannot absorb an unlucky batch, so there
is no safe over-dial available to it. Predictive dialing is a large-team technique. The
`predictive-small-team` scenario exists to demonstrate exactly this restraint, and the
seeded predictive campaign uses 20 agents so the over-dial is visible at all.

**Consequences.** `PredictiveDialer.varianceCap()` is a pure function with its own unit
tests. `safetyBufferSigmas: 0` disables the guard and reverts to pacing on expectation, which
is how the old behaviour can be reproduced. Two further guards landed with it: the answer-rate
estimate blends toward a *high* prior (0.9) when evidence is thin — high, because the estimate
is a divisor, so a high assumed rate produces fewer lines — and occupancy feedback is withheld
until enough calls have completed, since occupancy of zero at the start of a campaign means
"nothing has happened yet", not "we are under-dialing".

**AI contributor:** Claude Opus 5 (`claude-opus-5`), via Claude Code.

---

## D-014 — Safety denials are classified as backpressure or intervention

**Date:** 2026-08-31

**Context.** A healthy progressive campaign produced 1,063 `safety.denied` events in one short
run, and the simulation report presented all of them as "Safety interventions: 1063".

**Chosen.** Denial codes are classified in `src/services/safety.ts` next to the rules that
produce them. Capacity-related denials (agent capacity, the three concurrency ceilings, rate
limit, retry-not-due) are **backpressure**, emitted at `debug`. Everything else (DNC, attempt
limits, emergency stop, abandon threshold, campaign-not-running) is a genuine **intervention**,
emitted at `warn`. The simulation report counts them separately.

**Reason.** A dialer being told "no room right now" hundreds of times a minute is a dialer
working correctly. Reporting that as an intervention had two costs: it buried the events that
actually matter under routine chatter in the event log, and it made a clean run look alarming.
The same progressive scenario now reports `Safety interventions: 0, Capacity backpressure:
1063` — which is the truth.

**Tradeoffs.** Severity now carries semantic weight for this event type, so anyone adding a
new denial code must classify it. The classifier lives beside the rule list to make that
obvious.

**AI contributor:** Claude Opus 5 (`claude-opus-5`), via Claude Code.

---

## D-015 — Id counters are restored from the database at startup

**Date:** 2026-08-31

**Context.** Sequential ids (D-004) live in memory and start at 1 in every process, while the
database persists. A server restarted against a seeded database collided on its first event
insert and could not dial at all (BUG.md B-005).

**Options considered.** (a) Switch to UUIDs. (b) Prefix ids with a per-process token.
(c) Read the high-water mark per entity table at startup and continue from it.

**Chosen.** (c), via `src/db/id-recovery.ts`.

**Reason.** (a) and (b) both give up the readability that made sequential ids worth choosing —
`call_000042` telling you it was the forty-second call of the run is genuinely useful when
reading an event stream. (c) keeps that, and keeps a fresh in-memory database starting at 1,
so tests and simulations stay byte-for-byte deterministic.

**Tradeoffs.** One extra query per entity table at startup, and the recovery only recognises
ids of the form `<prefix>_<digits>` — readable custom ids in seed data (`agent_prog_01`) are
deliberately ignored so they cannot skew the counter.

**Consequences.** `IdGenerator.restore()` only ever moves a counter forward, so it cannot
reintroduce the collision. The broader lesson is recorded in B-005: every test used an
ephemeral database, which is precisely why none of them could see this.

**AI contributor:** Claude Opus 5 (`claude-opus-5`), via Claude Code.

---

## D-016 — The dashboard has no framework beyond React

**Date:** 2026-08-31

**Context.** The dashboard needs nine views, live updates, forms with validation, and a
consistent visual language.

**Options considered.** (a) A component library (MUI, Chakra) plus a router plus a data-fetching
library. (b) Tailwind plus headless components. (c) React, hand-written CSS tokens, a ~30-line
hash router, and two small hooks.

**Chosen.** (c). Runtime dependencies for the whole frontend: `react` and `react-dom`.

**Reason.** The dependency budget was spent on the engine deliberately, and each of the
alternatives buys less than it looks. A router package replaces thirty lines that do exactly
what nine flat views need. A data library's caching and revalidation would sit unused, because
this data is either polled on a short interval or pushed over SSE. A component library imposes
a visual language on a dashboard whose whole job is dense, legible operational information.

The one dependency that *was* worth adding is `eslint-plugin-react-hooks` — a stale dependency
array is invisible in review and produces exactly the failure this dashboard cannot afford: a
panel that silently stops updating while still looking authoritative.

**Tradeoffs.** Hand-written CSS means no utility-class safety net; consistency rests on the
token set in `web/src/styles.css`. The hash router has no nested routes or transitions, which
this UI does not need.

**Consequences.** The production bundle is 249 kB (74 kB gzipped), almost all of it React.
Hash routing means the built dashboard works from any static host with no rewrite rules.

**AI contributor:** Claude Opus 5 (`claude-opus-5`), via Claude Code.

---

## D-017 — The dashboard polls aggregates and streams transitions

**Date:** 2026-08-31

**Context.** SSE already pushes every event. It is tempting to derive all dashboard state from
that stream and never poll.

**Chosen.** SSE carries *transitions* (the event log, connection liveness). REST polling on a
1–3 second interval carries *aggregates* (metrics, counts, rates, dialer state).

**Reason.** Recomputing answer rates, occupancy and rolling windows in the browser from an
event feed would duplicate `MetricsService` — and the duplicate would be wrong the moment the
two drifted, in a way nobody would notice, because both would look plausible. The server
already computes these numbers correctly for the simulation reports; the dashboard should show
*those* numbers, not its own approximation of them.

It also means a browser that missed events while backgrounded recovers on the next poll rather
than displaying a silently diverged view.

**Tradeoffs.** More HTTP requests than a pure-stream design. At 1s intervals against a local
server this is not a real cost, and it is trivially adjustable.

**Consequences.** The shell owns one `EventSource` and shares it with every view — nine views
each opening their own would be nine subscribers on the server for no benefit.

**AI contributor:** Claude Opus 5 (`claude-opus-5`), via Claude Code.
