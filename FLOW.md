# FLOW

How execution actually travels through the application, at the level of concrete modules and
functions. Every path below is implemented and exercised by tests.

---

## Progressive dialing

```
CampaignService.start(id)                              src/services/campaign-service.ts
  ├─ refuses a campaign with no contacts or no agents  (such a campaign ticks and does
  │                                                     nothing, which looks like a bug)
  ├─ #transition DRAFT -> READY -> RUNNING
  └─ DialerEngine.start(id)                            src/services/dialer-engine.ts
       └─ #scheduleTick -> clock.setTimer(tickIntervalMs)

DialerEngine.tick(campaignId)                          every tickIntervalMs of virtual time
  ├─ ContactRepository.promoteDueRetries()             backoff elapsed -> READY
  ├─ #reclaimExpiredLeases()                           backstop for a lost watchdog
  ├─ #checkAbandonThreshold()                          evaluated EVERY tick (B-003)
  ├─ #campaignGate()  ── denied ──▶ emit safety.denied, stand down if nothing in flight
  │                                 (no contact is reserved for a campaign-wide denial)
  ├─ buildSnapshot()                                   narrow indexed queries only (B-002)
  ├─ ProgressiveDialer.computeDialPlan(snapshot)       pure function
  │     capacity   = floor(availableAgents x lineRatio)
  │     desired    = capacity - pendingConnections
  │     attempts   = applyLimits(desired, ...)
  └─ for each attempt: #attemptDial()
```

`#attemptDial` — the ordering here is the correctness argument:

```
1. ContactRepository.reserveNext()      atomic CAS; loser gets null and skips
2. SafetyEngine.canInitiateCall()       the only evaluation that spends a rate-limit token
     └─ denied ──▶ #releaseContact()    always; a leaked reservation stalls the campaign
3. ConcurrencyService.tryAcquire()      synchronous, all-or-nothing across all 3 scopes
     └─ denied ──▶ #releaseContact()
4. CallRepository.createCallWithAttempt()   one transaction: call + attempt together
5. #armWatchdog()                       before the provider call, so silence is covered
6. provider.createCall()                the first await in the whole sequence
     └─ throws ──▶ #handleCreateCallFailure(): release lease, release contact, classify
```

Nothing asynchronous happens before step 6. That is what makes steps 1–3 safe: no other
worker can interleave between checking capacity and claiming it.

## Provider events → call state → agent

```
MockTelecomProvider schedules its whole lifecycle on the clock at accept time
  └─ DialerEngine.handleProviderEvent(event)           #byProviderCallId correlates
       ├─ call.dialing / call.ringing  -> #transitionCall
       ├─ call.answered                -> #handleAnswered
       │    ├─ AgentService.reserveForCall()   atomic CAS on AVAILABLE
       │    ├─ found     -> agent RESERVED -> ON_CALL, call CONNECTED
       │    └─ not found -> queue in #awaitingAgent, arm abandon timer
       │                     └─ abandonTimeoutMs elapses -> #abandon()
       ├─ call.completed               -> #handleCompleted -> #settle('ENDED')
       └─ call.no_answer/busy/failed   -> #settle(terminal)

#settle(context, status, outcome)
  ├─ #transitionCall(status)
  ├─ CallRepository.finalize()          call + attempt, one transaction
  ├─ AgentService.release()             AVAILABLE, handle time accumulated
  ├─ ConcurrencyService.release(lease)  idempotent; double release is a no-op
  ├─ RetryService.decide()
  │    ├─ retry     -> ContactRepository.scheduleRetry(), emit retry.scheduled
  │    └─ no retry  -> contact EXHAUSTED, emit retry.exhausted
  └─ #serviceAwaitingQueue()            a freed agent may take a queued answered call
```

## Predictive dialing

Identical except for the plan. `PredictiveDialer.computeDialPlan`:

```
availableAgents == 0 ──▶ 0 attempts (dialing into no capacity is how calls get abandoned)
estimateAnswerRate()      blend(historical 0.3, recent 0.7) towards a HIGH prior (0.9)
                          in proportion to evidence, then floored at minAnswerRate
occupancyAdjustment()     held at 1.00 until occupancyMinSample calls complete
abandonAdjustment()       degrades pacing from 1.0 down to 0.25 as abandonment rises
targetLines = ceil(availableAgents x multiplier / answerRate)
varianceCap()             solves  Lp + k·sqrt(Lp(1-p)) <= seats   for L      ← D-013
maxLinesPerAgent ceiling
minus pendingConnections
applyLimits()             campaign, global, provider, rate limit, contacts remaining
```

Each clamp appends to `reasoning[]`, which is returned by
`GET /api/campaigns/:id/metrics` and rendered live.

## Failure and retry

```
provider error / timeout / terminal failure
  └─ classifyFailure()                  src/services/retry.ts
       ├─ TRANSIENT   timeout, provider error, outage, busy, no answer, abandoned
       └─ PERMANENT   invalid number, DNC, attempts exceeded, cancelled, unknown code
  └─ RetryService.decide()
       ├─ PERMANENT or attempts exhausted -> contact EXHAUSTED, retry.exhausted
       └─ otherwise -> nextAttemptAt = now + computeBackoff()
                       exponential, capped, with seeded jitter so a batch that failed
                       together does not retry together
```

## Timeout watchdog

The case that matters: the provider never sends a terminal event at all.

```
#armWatchdog(context)      clock.setTimer(providerTimeoutMs)
  ├─ terminal event first  -> clock.clearTimer, watchdog never runs
  └─ watchdog first        -> #onTimeout()
       ├─ provider.cancelCall()
       ├─ #settle('TIMEOUT', 'TIMEOUT')   releases lease, agent, schedules retry
       └─ emit call.timeout + provider.timeout

ConcurrencyService.sweepExpired()   independent backstop, run each tick, in case a
                                    watchdog itself is lost
```

## Emergency stop

```
POST /api/system/emergency-stop
  └─ SystemService.engage(reason)
       ├─ sets the flag; emits safety.emergency_stop -> SSE -> dashboard
       └─ every subsequent SafetyEngine evaluation denies with EMERGENCY_STOP,
          because it is the FIRST rule in the ordered list
             └─ a campaign with nothing in flight stands down (stops ticking)

POST /api/system/emergency-resume
  └─ SystemService.release()
       └─ emits safety.emergency_resume, which DialerEngine subscribes to
            └─ resumeStalled() restarts campaigns that stood down
               (without this the control would be one-way in practice)
```

## Campaign stop

```
CampaignService.stop(id)
  ├─ DialerEngine.stop(id)         clears the tick timer, unsubscribes from the provider
  └─ cancels every call in flight  CONNECTED -> CANCELLED is a legal transition precisely
                                   so this works; without it the call row froze while its
                                   lease was released and the ledger drifted (B-001)
```

## Simulation

```
SimulationService.runToCompletion(config)
  ├─ #buildContainer()      its own in-memory DB, clock, RNG, provider — a chaos scenario
  │                         cannot disturb live campaigns
  ├─ seeds campaign, agents, contacts (incl. DNC and prior-attempt contacts)
  ├─ speed 0  -> FastDriver.run()      drains the clock; minutes complete in milliseconds
  │  speed >0 -> #runPaced()           real-time observation, polled from outside the clock
  ├─ samples concurrency and utilisation on every tick
  └─ #buildReport()         full statistics + InvariantChecker verdict
```
