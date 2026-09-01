# SCALE

> *"Tell us what you think will break first. Then tell us how you would fix it. A good answer
> isn't 'add more servers'."*

So this is measured, not asserted. `npm run load` runs the real engine at increasing agent
counts; every number below came from it on an M-series Mac, single process. The absolute
figures are machine-specific — **the shape of the curve is the finding.**

---

## What the measurement says

| agents | contacts | attempts | connected | events | ms/tick | µs/event |
|---:|---:|---:|---:|---:|---:|---:|
| 50 | 400 | 129 | 50 | 1,327 | 0.79 | 124 |
| 200 | 1,600 | 438 | 202 | 4,076 | 4.44 | 264 |
| 1,000 | 8,000 | 3,087 | 1,105 | 26,225 | 60.72 | 1,151 |
| 3,000 | 24,000 | 1,173 | 157 | 8,997 | 161.62 | 3,377 |

**60× the agents costs 205× per tick.** Invariants hold at every size — the system stays
*correct* as it degrades, it just stops keeping up. At 3,000 agents utilisation collapses to
8%: the tick takes longer than the tick interval, so the dialer spends its time planning
rather than dialing.

---

## What broke first, and why

**The contact-reservation query.** Not the concurrency ledger, not the event log, not SQLite
write throughput — the `SELECT` that picks the next borrower to call.

It runs **once per dial attempt**, and it ordered by `(next_attempt_at, id)`. Every freshly
imported contact has `next_attempt_at = NULL`, so they all compare equal on that column, and
the index stopped there. SQLite fell back to a temp b-tree and **sorted the entire dialable
set of the campaign to pick one row** — on every attempt.

```
SEARCH contacts USING INDEX idx_contacts_campaign_status
USE TEMP B-TREE FOR ORDER BY          <-- sorts every dialable contact, per attempt
```

With N attempts per tick against a campaign of M contacts, that is O(N·M) per tick. Measured:

| | 200 agents | 1,500 agents |
|---|---:|---:|
| `reserveNext` before | 112 µs | **722 µs** |
| `reserveNext` after | 18.1 µs | **17.9 µs** |

Extending the index to cover the tiebreak (`migrations/002`) made it a covering-index lookup:
**40× faster at 1,500 agents, and flat** — the same cost at 1,500 as at 200. End to end that
took 1,000 agents from 875 to 1,105 connections and 3,000 agents from 67 to 157.

Two things about this worth saying plainly. First, I got it wrong twice before measuring
properly: I "fixed" an O(n) in-memory scan and a redundant `CASE` in the same query, and
neither moved the number at all. The profiler found it; my intuition did not. Second, the
fault was invisible at demo scale — at 50 agents the query costs 112 µs and nothing looks
wrong.

---

## What breaks next — in order

The curve is still superlinear (205× for 60×), so the covering index was the biggest term, not
the only one. In the order I would expect them to bite:

**1. Per-attempt database round trips.** `#safetyContext` is assembled once per dial attempt
and issues `agents.availableCount` — 6.5 µs at 200 agents, 41.6 µs at 1,500, linear in agent
count. At 3,000 agents dialing 300 attempts a tick that is ~12 ms of counting alone.

*Fix:* maintain agent availability as an in-memory counter alongside the concurrency ledger,
invalidated on every agent transition, rather than counting rows. The transitions already flow
through `AgentService`, so there is exactly one place to hook. Same shape as the fix already
applied to `pendingConnections`.

**2. Event write volume.** 26,225 events for 1,000 agents — roughly 8 per call — batched into
one transaction per tick. Fine here; at 10,000 agents it is ~250k events for a five-minute
campaign, and the batch itself becomes the tick.

*Fix:* the events table is an append-only audit log that nothing reads on the hot path. Move
it off the dialing transaction entirely — write to a ring buffer and flush from a separate
timer, accepting that the newest events lag the engine by a tick. Nothing in the safety path
depends on a persisted event.

**3. The single-process concurrency ledger.** This is the architectural ceiling, not a
performance one. Admission control is an in-memory map (D-007), which is what makes
`tryAcquire` synchronous and therefore race-free without locks. One process can only run one
event loop, and the tick is CPU-bound work on a single thread.

*Fix, and the honest answer to 10,000 agents:* shard by campaign. One worker owns a campaign
outright and holds its ledger in memory; the ledger stays synchronous and the correctness
argument survives intact. Cross-campaign global limits become a coordination problem, solved
with a token lease from a shared store — each worker draws a block of global slots and
returns what it does not use. That trades exactness at the global limit for the ability to
scale, which is the right trade *provided the per-campaign limits stay exact* — they are the
ones that bound abandonment.

What I would not do is put the per-call ledger in a shared store. That turns a synchronous
check-and-set into a network round trip on the hottest path in the system, and reintroduces
the check-then-act race the current design exists to avoid.

---

## What does *not* break

Worth stating, because it is where I expected trouble and did not find it:

* **`calls.activeCount`** — flat at 1.2 µs from 200 to 1,500 agents. The partial index does
  its job.
* **The concurrency ledger** — Map lookups, O(1), invisible in the profile at every size.
* **Correctness** — invariants passed at all four sizes. The system degrades by getting
  slower, never by over-dialing. That is the property worth having under load.

---

## The honest limits of this measurement

* Single process, single machine, in-memory SQLite. Real deployments would hit disk, network
  and a real provider's rate limits well before some of this.
* Virtual time: the engine is measured doing its own work, with no real telephony latency. It
  isolates *our* cost, which is what the question asks, but it is not a throughput figure.
* The 3,000-agent row is truncated by the load test's 30-second real-time cap, so its
  `connected` count understates what the system would eventually achieve. The `ms/tick`
  figure — the one the argument rests on — is unaffected.
