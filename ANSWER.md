# The final question

> *How would you build a SmartDialer that gets as much of the utilization benefit of
> predictive dialing as possible, while retaining the deterministic safety characteristics of
> progressive dialing?*

---

## The short answer

Separate the *guess* from the *guarantee*, and never let the guess touch the phone.

Predictive dialing is a statistical bet. Progressive dialing is a deterministic invariant.
Most designs try to make one component do both, and it always ends the same way — the
component that computes an aggressive number is the same component that bounds it, so it has
no bound at all. Every pacing bug becomes a safety bug.

So: let the pacing engine be as clever as it likes, and give it no way to act. It produces a
*request*. A separate Safety Controller — which never sees the pacer's reasoning, only its
number — decides what is permitted, and the allocator acts only on the approved count.

```
Pacing Engine  ──"I think 15"──▶  Safety Controller  ──"you may have 4"──▶  Allocator
   (a guess)                        (the guarantee)                        (the action)
```

The controller can approve, reduce, reject, or **fall back to progressive**. That last verdict
is the whole answer in one word: when the bet stops being credible, stop betting — but keep
dialing, at one line per free agent, which abandons nobody.

## Why that gets you most of the utilization

The bet is only worth making when the estimate behind it is good. In this implementation the
controller degrades to progressive when:

* there is not yet enough evidence for an answer rate (a cold start is not a licence to guess);
* the provider is unhealthy — a carrier that is refusing calls is not one whose answer
  statistics mean anything;
* abandonment is climbing toward the limit, *before* it crosses it.

Outside those conditions it over-dials freely. In the measured scenarios that is 73% agent
utilisation with a **0.0% abandon rate** on a 20-agent campaign — most of the predictive
benefit, none of the predictive harm.

## The part most people get wrong

Pacing on the *expected* number of answers is not safe, and this is the mistake I actually
made and had to fix (`BUG.md` B-004). Eight lines at a 50% answer rate averages four answers.
But answers are binomial, and roughly one batch in seven produces more answers than there are
agents. Every one of those excess answers is a person picking up to silence. Pacing to the
mean guarantees you overshoot about half the time.

So bound the *tail*, not the average:

```
    L·p + k·√(L·p·(1−p))  ≤  free seats
```

Solve for `L`. With `k = 1.5` that is roughly a 7% chance of a given batch overshooting,
instead of ~50%. It produces the behaviour real predictive dialers show: **the safe over-dial
ratio grows with team size** — five seats support about six lines, twenty seats support
thirty-one. Small teams cannot safely over-dial at all, because one unlucky batch is a large
fraction of their capacity. That is why a five-agent predictive campaign in this system is
paced down to roughly 1:1, and why that is correct rather than a bug.

That bound belongs in the *controller*, not only the pacer — for the same reason as everything
else here. A limit that lives only inside the thing it constrains is not a limit.

## What keeps it deterministic

Progressive dialing's real virtue is not its pacing, it is that its safety properties are
*invariants* rather than *outcomes*. Preserving that under predictive pacing means:

**Every limit is enforced per call, after the pacing decision.** Contact reservation is an
atomic conditional `UPDATE`; agent reservation is the same; concurrency slots are acquired
synchronously across global, campaign and provider scope, all-or-nothing, with no `await`
between checking capacity and claiming it. Two workers cannot take the same agent because the
loser's `UPDATE` matches zero rows — not because they were careful.

**The invariants are asserted continuously, against the database, independently of the
in-memory ledger.** The most valuable check in the system compares the two: a ledger that has
drifted below reality is the signature of a double-release, and it is silent until something
over-dials. It caught a real bug (`B-001`).

**Abandonment has a latched circuit breaker.** Crossing the threshold pauses predictive
dialing and requires an explicit human resume — the system never un-pauses itself, because the
condition that tripped it is the condition that would trip it again. It acts on a Wilson score
lower bound rather than a fixed minimum sample, so it reacts as soon as the evidence is strong
rather than after a fixed number of people have been abandoned (`B-013`).

## What I would do differently with another week

The most instructive thing that happened while building this: I spent a long time believing the
long-talk-time abandonment (`B-015`) was a *modelling* problem — that the pacer needed a better
theory of when seats become free. I tested two hypotheses against it and both were disproved by
measurement.

It was an arithmetic bug. `pendingConnections` was computed as
`ledgerActiveCalls − connectedCalls`, two different sources subtracted from each other, and it
went **negative** whenever a call outlived its concurrency lease. The pacer *subtracts* that
value, so −19 added nineteen lines of phantom capacity: with one free agent it approved ten
calls. Fixing it took three scenarios from 5–22% abandonment at ~60% utilisation to **0–0.4%
abandonment at 84–94%**, roughly eight times the throughput.

The lesson I would carry forward is about where to look. A sophisticated-sounding symptom
invited a sophisticated explanation, and the actual fault was a subtraction between two things
that were never guaranteed to be comparable. What found it was printing the numbers the pacer
was actually given, which I should have done first.

A residual weakness remains at very low answer rates (`pacing-a`, 20%). What is now known about
it that was not before: sweeping the variance guard from 1.5σ to 3.0σ changes those results by
*exactly nothing*, so the guard is not the binding constraint and tuning it is pointless. The
next thing to try is the time-to-free-seat model — which was my original hypothesis, and may
yet be right, but I would now want the measurement before the theory.

The second thing would be the sharded-worker model in `SCALE.md` — not for throughput, but
because a single-process ledger is the assumption most likely to be wrong in production, and
I would rather find out what breaks while it is still a prototype.
