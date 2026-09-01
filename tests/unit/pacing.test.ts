import { describe, expect, it } from 'vitest';
import { PredictiveDialer, DEFAULT_PREDICTIVE_TUNING } from '../../src/dialer/predictive.ts';
import { ProgressiveDialer } from '../../src/dialer/progressive.ts';
import type { DialerSnapshot } from '../../src/dialer/strategy.ts';
import { makeCampaign } from '../helpers/fixtures.ts';

/** A snapshot with every limit wide open, so a test can constrain exactly one thing. */
function snapshot(overrides: Partial<DialerSnapshot> = {}): DialerSnapshot {
  return {
    now: 1000,
    campaign: makeCampaign(),
    totalAgents: 10,
    availableAgents: 10,
    occupiedAgents: 0,
    activeCalls: 0,
    pendingConnections: 0,
    connectedCalls: 0,
    historicalAnswerRate: 0.6,
    recentAnswerRate: 0.6,
    recentSample: 100,
    abandonRate: 0,
    abandonSample: 0,
    campaignHeadroom: 999,
    globalHeadroom: 999,
    providerHeadroom: 999,
    rateLimitHeadroom: 999,
    remainingContacts: 999,
    ...overrides,
  };
}

describe('ProgressiveDialer', () => {
  const dialer = new ProgressiveDialer();

  it('dials one line per free agent', () => {
    expect(dialer.computeDialPlan(snapshot({ availableAgents: 3 })).requested).toBe(3);
  });

  it('never dials with no free agents', () => {
    // The defining guarantee of progressive mode: every answered call has someone waiting.
    const plan = dialer.computeDialPlan(snapshot({ availableAgents: 0 }));
    expect(plan.requested).toBe(0);
    expect(plan.reasoning.join(' ')).toContain('no spare agent capacity');
  });

  it('counts calls in flight against capacity, not just connected ones', () => {
    // A ringing call has committed a seat even though it has not consumed one. Ignoring it
    // is the single easiest way to turn a progressive dialer into an accidental predictive
    // one: dial again, both answer, and one caller hears silence.
    expect(
      dialer.computeDialPlan(snapshot({ availableAgents: 5, pendingConnections: 3 })).requested,
    ).toBe(2);
    expect(
      dialer.computeDialPlan(snapshot({ availableAgents: 5, pendingConnections: 5 })).requested,
    ).toBe(0);
  });

  it('honours a lineRatio below one for a cautious campaign', () => {
    const campaign = makeCampaign({
      safety: { ...makeCampaign().safety, lineRatio: 0.5 },
    });
    expect(dialer.computeDialPlan(snapshot({ campaign, availableAgents: 10 })).requested).toBe(5);
  });

  it('honours a lineRatio above one for a deliberate mild over-dial', () => {
    const campaign = makeCampaign({
      safety: { ...makeCampaign().safety, lineRatio: 2 },
    });
    expect(dialer.computeDialPlan(snapshot({ campaign, availableAgents: 4 })).requested).toBe(8);
  });

  it('ignores concurrency limits — bounding the request is not its job', () => {
    // The pacer asks for what agent capacity warrants and stops. Applying the ceilings here
    // as well would put the bound inside the component it is supposed to bound
    // (DECISIONS.md D-018); SafetyController is what cuts this down.
    expect(
      dialer.computeDialPlan(snapshot({ availableAgents: 10, campaignHeadroom: 2 })).requested,
    ).toBe(10);
    expect(
      dialer.computeDialPlan(snapshot({ availableAgents: 10, remainingContacts: 1 })).requested,
    ).toBe(10);
  });

  it('ignores the answer rate entirely', () => {
    // Progressive pacing is deliberately not predictive: a terrible answer rate must not
    // make it start over-dialing.
    const low = dialer.computeDialPlan(
      snapshot({ availableAgents: 4, historicalAnswerRate: 0.05, recentAnswerRate: 0.05 }),
    );
    const high = dialer.computeDialPlan(
      snapshot({ availableAgents: 4, historicalAnswerRate: 0.95, recentAnswerRate: 0.95 }),
    );
    expect(low.requested).toBe(4);
    expect(high.requested).toBe(4);
  });

  it('explains its arithmetic', () => {
    const plan = dialer.computeDialPlan(snapshot({ availableAgents: 3, pendingConnections: 1 }));
    expect(plan.reasoning[0]).toContain('3 available agent(s)');
    expect(plan.reasoning.join(' ')).toContain('minus 1 call(s) already in flight');
  });

  it('is a pure function of its snapshot', () => {
    const input = snapshot({ availableAgents: 4 });
    const frozen = JSON.stringify(input);
    dialer.computeDialPlan(input);
    dialer.computeDialPlan(input);
    expect(JSON.stringify(input)).toBe(frozen);
  });
});

describe('PredictiveDialer — the answer-rate estimate', () => {
  const dialer = new PredictiveDialer();

  it('starts from a high, conservative prior before any calls complete', () => {
    // The estimate is a DIVISOR, so a high assumed answer rate produces FEWER lines. Opening
    // at ~1 line per agent and ramping up is the safe direction (BUG.md B-004).
    const reasoning: string[] = [];
    const rate = dialer.estimateAnswerRate(snapshot({ recentSample: 0 }), reasoning);
    expect(rate).toBe(DEFAULT_PREDICTIVE_TUNING.coldStartAnswerRate);
    expect(reasoning.join(' ')).toContain('conservative prior');
  });

  it('weights the recent window above lifetime history', () => {
    // A campaign that answered well an hour ago and badly now must pace on the second fact.
    const rate = dialer.estimateAnswerRate(
      snapshot({ historicalAnswerRate: 0.9, recentAnswerRate: 0.2, recentSample: 200 }),
      [],
    );
    expect(rate).toBeCloseTo(0.9 * 0.3 + 0.2 * 0.7, 5);
  });

  it('blends towards the prior in proportion to evidence', () => {
    // Two no-answers must not be read as "0% answer rate".
    const thin = dialer.estimateAnswerRate(
      snapshot({ historicalAnswerRate: 0, recentAnswerRate: 0, recentSample: 2 }),
      [],
    );
    const thick = dialer.estimateAnswerRate(
      snapshot({ historicalAnswerRate: 0, recentAnswerRate: 0, recentSample: 200 }),
      [],
    );
    expect(thin).toBeGreaterThan(thick);
    expect(thin).toBeGreaterThan(0.7);
  });

  it('floors the estimate so the line count stays bounded', () => {
    // agents / answerRate with an estimate near zero asks for an unbounded number of lines.
    const reasoning: string[] = [];
    const rate = dialer.estimateAnswerRate(
      snapshot({ historicalAnswerRate: 0, recentAnswerRate: 0, recentSample: 10_000 }),
      reasoning,
    );
    expect(rate).toBe(DEFAULT_PREDICTIVE_TUNING.minAnswerRate);
    expect(reasoning.join(' ')).toContain('floored');
  });

  it('never exceeds 1', () => {
    expect(
      dialer.estimateAnswerRate(
        snapshot({ historicalAnswerRate: 1, recentAnswerRate: 1, recentSample: 500 }),
        [],
      ),
    ).toBeLessThanOrEqual(1);
  });
});

describe('PredictiveDialer — the variance guard', () => {
  const dialer = new PredictiveDialer();

  it('keeps expected answers plus variance within available seats', () => {
    // The control that actually prevents abandonment. Pacing to the mean is not enough:
    // 8 lines at p=0.5 averages 4 answers, but roughly one batch in seven overshoots.
    const seats = 20;
    const p = 0.5;
    const lines = dialer.varianceCap(seats, p);

    const mean = lines * p;
    const sigma = Math.sqrt(lines * p * (1 - p));
    expect(mean + DEFAULT_PREDICTIVE_TUNING.safetyBufferSigmas * sigma).toBeLessThanOrEqual(seats + 1);
  });

  it('permits a larger over-dial ratio for a larger team', () => {
    // The behaviour that matches real predictive dialing: a small team cannot safely
    // over-dial, because one unlucky batch is a large fraction of its capacity.
    const ratio = (seats: number): number => dialer.varianceCap(seats, 0.5) / seats;
    expect(ratio(5)).toBeLessThan(ratio(20));
    expect(ratio(20)).toBeLessThan(ratio(100));
  });

  it('paces a small team down to roughly one line per agent', () => {
    expect(dialer.varianceCap(5, 0.5)).toBeLessThanOrEqual(7);
    expect(dialer.varianceCap(1, 0.5)).toBe(1);
  });

  it('never paces below progressive dialing', () => {
    // One line per seat abandons nobody, so the guard must never go under it.
    for (const seats of [1, 2, 3, 5, 10, 50]) {
      for (const p of [0.01, 0.1, 0.5, 0.9, 1]) {
        expect(dialer.varianceCap(seats, p), `seats=${seats} p=${p}`).toBeGreaterThanOrEqual(seats);
      }
    }
  });

  it('allows more lines as the answer rate falls', () => {
    expect(dialer.varianceCap(20, 0.2)).toBeGreaterThan(dialer.varianceCap(20, 0.8));
  });

  it('returns zero with no seats', () => {
    expect(dialer.varianceCap(0, 0.5)).toBe(0);
  });

  it('falls back to pure expectation when the buffer is disabled', () => {
    const noBuffer = new PredictiveDialer({ safetyBufferSigmas: 0 });
    expect(noBuffer.varianceCap(10, 0.5)).toBe(20);
  });
});

describe('PredictiveDialer — occupancy feedback', () => {
  const dialer = new PredictiveDialer();

  it('holds at 1.00 until enough calls have completed', () => {
    // Occupancy of 0 at the start of a campaign means "nothing has happened yet", not
    // "we are under-dialing". Boosting on it compounds with an uncertain answer-rate
    // estimate — which is what produced a 3x over-dial (BUG.md B-004).
    const reasoning: string[] = [];
    const adjustment = dialer.occupancyAdjustment(
      snapshot({ occupiedAgents: 0, totalAgents: 10, recentSample: 2 }),
      reasoning,
    );
    expect(adjustment).toBe(1);
    expect(reasoning.join(' ')).toContain('held at 1.00');
  });

  it('leans in when agents are idler than the target', () => {
    const adjustment = dialer.occupancyAdjustment(
      snapshot({ occupiedAgents: 2, totalAgents: 10, recentSample: 100 }),
      [],
    );
    expect(adjustment).toBeGreaterThan(1);
  });

  it('pulls back when agents are busier than the target', () => {
    const adjustment = dialer.occupancyAdjustment(
      snapshot({ occupiedAgents: 10, totalAgents: 10, recentSample: 100 }),
      [],
    );
    expect(adjustment).toBeLessThan(1);
  });

  it('is bounded on both sides so feedback cannot run away', () => {
    // An unbounded correction oscillates: over-dial, abandon, pull back hard, idle,
    // over-dial again.
    const extreme = new PredictiveDialer({ occupancyGain: 1000 });
    const high = extreme.occupancyAdjustment(
      snapshot({ occupiedAgents: 0, totalAgents: 10, recentSample: 100 }),
      [],
    );
    const low = extreme.occupancyAdjustment(
      snapshot({ occupiedAgents: 10, totalAgents: 10, recentSample: 100 }),
      [],
    );
    expect(high).toBe(DEFAULT_PREDICTIVE_TUNING.maxOccupancyAdjustment);
    expect(low).toBe(DEFAULT_PREDICTIVE_TUNING.minOccupancyAdjustment);
  });

  it('is neutral with no agents at all', () => {
    expect(dialer.occupancyAdjustment(snapshot({ totalAgents: 0 }), [])).toBe(1);
  });
});

describe('PredictiveDialer — abandon-rate degradation', () => {
  const dialer = new PredictiveDialer();
  const campaign = makeCampaign({ dialingMode: 'PREDICTIVE', maxAbandonRate: 0.04 });

  it('ignores abandonment below the minimum sample', () => {
    // One abandoned call out of one would otherwise read as 100%.
    expect(
      dialer.abandonAdjustment(snapshot({ campaign, abandonRate: 1, abandonSample: 1 }), []),
    ).toBe(1);
  });

  it('stays at full pacing well below the threshold', () => {
    expect(
      dialer.abandonAdjustment(snapshot({ campaign, abandonRate: 0.01, abandonSample: 100 }), []),
    ).toBe(1);
  });

  it('degrades gradually as abandonment approaches the threshold', () => {
    // Deliberately gradual: backing off before the hard stop is what keeps a campaign
    // running instead of sawtoothing between full speed and a halt.
    const near = dialer.abandonAdjustment(
      snapshot({ campaign, abandonRate: 0.032, abandonSample: 100 }),
      [],
    );
    const over = dialer.abandonAdjustment(
      snapshot({ campaign, abandonRate: 0.06, abandonSample: 100 }),
      [],
    );
    expect(near).toBeLessThan(1);
    expect(over).toBeLessThan(near);
  });

  it('never degrades below a quarter speed', () => {
    expect(
      dialer.abandonAdjustment(snapshot({ campaign, abandonRate: 1, abandonSample: 500 }), []),
    ).toBe(0.25);
  });
});

describe('PredictiveDialer — the whole plan', () => {
  const dialer = new PredictiveDialer();
  const campaign = makeCampaign({
    dialingMode: 'PREDICTIVE',
    safety: { ...makeCampaign().safety, maxLinesPerAgent: 3 },
  });

  it('over-dials a large team at a moderate answer rate', () => {
    const plan = dialer.computeDialPlan(
      snapshot({
        campaign,
        totalAgents: 40,
        availableAgents: 20,
        occupiedAgents: 20,
        recentSample: 200,
        historicalAnswerRate: 0.5,
        recentAnswerRate: 0.5,
      }),
    );
    expect(plan.requested).toBeGreaterThan(20);
  });

  it('does not over-dial a small team', () => {
    const plan = dialer.computeDialPlan(
      snapshot({
        campaign,
        totalAgents: 5,
        availableAgents: 5,
        recentSample: 200,
        historicalAnswerRate: 0.5,
        recentAnswerRate: 0.5,
      }),
    );
    expect(plan.requested).toBeLessThanOrEqual(7);
  });

  it('refuses to dial with no free agents', () => {
    const plan = dialer.computeDialPlan(snapshot({ campaign, availableAgents: 0 }));
    expect(plan.requested).toBe(0);
    expect(plan.reasoning.join(' ')).toContain('at least one free seat');
  });

  it('does not apply maxLinesPerAgent — that ceiling belongs to the controller', () => {
    const strict = makeCampaign({
      dialingMode: 'PREDICTIVE',
      safety: { ...makeCampaign().safety, maxLinesPerAgent: 1 },
    });
    const plan = dialer.computeDialPlan(
      snapshot({
        campaign: strict,
        totalAgents: 50,
        availableAgents: 50,
        recentSample: 500,
        historicalAnswerRate: 0.2,
        recentAnswerRate: 0.2,
      }),
    );
    // The variance guard still restrains it — that is the pacer being conservative on its own
    // account, which is different from enforcing a safety limit.
    expect(plan.requested).toBeGreaterThan(50);
    expect(plan.reasoning.join(' ')).toContain('sigma safety buffer');
  });

  it('subtracts calls already in flight', () => {
    const base = dialer.computeDialPlan(
      snapshot({ campaign, availableAgents: 20, totalAgents: 20, recentSample: 200 }),
    );
    const withFlight = dialer.computeDialPlan(
      snapshot({
        campaign,
        availableAgents: 20,
        totalAgents: 20,
        recentSample: 200,
        pendingConnections: 5,
      }),
    );
    expect(base.requested - withFlight.requested).toBe(5);
  });

  it('returns zero when calls in flight already meet the target', () => {
    const plan = dialer.computeDialPlan(
      snapshot({ campaign, availableAgents: 2, totalAgents: 20, pendingConnections: 100 }),
    );
    expect(plan.requested).toBe(0);
    expect(plan.reasoning.join(' ')).toContain('target already met');
  });

  it('asks freely regardless of the concurrency ceilings', () => {
    // Deliberate. A pacer that reads the ceilings would be enforcing them, and a component
    // that enforces its own bound has no bound. Every one of these is applied downstream by
    // SafetyController — see tests/unit/safety-controller.test.ts.
    for (const limit of ['campaignHeadroom', 'globalHeadroom', 'providerHeadroom', 'rateLimitHeadroom', 'remainingContacts'] as const) {
      const plan = dialer.computeDialPlan(
        snapshot({ campaign, availableAgents: 20, totalAgents: 20, recentSample: 200, [limit]: 0 }),
      );
      expect(plan.requested, limit).toBeGreaterThan(0);
    }
  });

  it('explains every step of its arithmetic', () => {
    const plan = dialer.computeDialPlan(
      snapshot({ campaign, availableAgents: 20, totalAgents: 20, recentSample: 200 }),
    );
    const text = plan.reasoning.join(' | ');
    expect(text).toContain('answer rate');
    expect(text).toContain('pacing multiplier');
    expect(text).toContain('line(s)');
  });

  it('is a pure function of its snapshot', () => {
    const input = snapshot({ campaign, availableAgents: 12, recentSample: 100 });
    const frozen = JSON.stringify(input);
    const a = dialer.computeDialPlan(input);
    const b = dialer.computeDialPlan(input);
    expect(JSON.stringify(input)).toBe(frozen);
    expect(a.requested).toBe(b.requested);
  });
});

describe('Progressive vs predictive', () => {
  it('predictive never asks for fewer lines than progressive would', () => {
    // Predictive is progressive plus a bet. If it ever asked for less, the bet would be
    // costing throughput rather than buying it.
    const campaign = makeCampaign({ dialingMode: 'PREDICTIVE' });
    for (const availableAgents of [1, 3, 5, 10, 25, 50]) {
      const base = snapshot({
        campaign,
        availableAgents,
        totalAgents: availableAgents,
        recentSample: 200,
        historicalAnswerRate: 0.5,
        recentAnswerRate: 0.5,
      });
      const progressive = new ProgressiveDialer().computeDialPlan(base).requested;
      const predictive = new PredictiveDialer().computeDialPlan(base).requested;
      expect(predictive, `agents=${availableAgents}`).toBeGreaterThanOrEqual(progressive);
    }
  });
});
