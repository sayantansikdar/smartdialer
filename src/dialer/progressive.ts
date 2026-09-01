/**
 * Progressive dialing.
 *
 * The rule is one sentence: **dial the next contact only when there is agent capacity to
 * take it.** Every answered call has a person waiting for it, so a progressive campaign
 * never abandons anyone — which is why it is the safe default and the mode a nervous
 * operator should start with.
 *
 * The subtlety is what counts against capacity. It is not the number of *connected* calls,
 * it is the number of calls **in flight that could still connect** (`pendingConnections`).
 * A call that is ringing has not consumed a seat yet, but it has committed one: if you
 * ignore it and dial again, and both answer, one of them has nobody to talk to. Counting
 * only connected calls is the single easiest way to turn a progressive dialer into an
 * accidental predictive one.
 */

import type { DialerSnapshot, DialerStrategy, DialPlan } from './strategy.ts';

export class ProgressiveDialer implements DialerStrategy {
  readonly mode = 'PROGRESSIVE' as const;

  computeDialPlan(snapshot: DialerSnapshot): DialPlan {
    const reasoning: string[] = [];
    const lineRatio = snapshot.campaign.safety.lineRatio;

    const capacity = Math.floor(snapshot.availableAgents * lineRatio);
    reasoning.push(
      `${snapshot.availableAgents} available agent(s) x lineRatio ${lineRatio} = ${capacity} line(s)`,
    );

    const desired = capacity - snapshot.pendingConnections;
    reasoning.push(
      `minus ${snapshot.pendingConnections} call(s) already in flight = ${Math.max(0, desired)}`,
    );

    if (desired <= 0) {
      reasoning.push('no spare agent capacity; waiting for a call to resolve');
      return { requested: 0, reasoning };
    }

    // Requested, not decided. The SafetyController applies every ceiling.
    return { requested: desired, reasoning };
  }
}
