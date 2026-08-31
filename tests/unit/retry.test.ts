import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/core/rng.ts';
import { classifyFailure, RetryService } from '../../src/services/retry.ts';
import { makeCampaign } from '../helpers/fixtures.ts';

const service = (seed = 1): RetryService =>
  new RetryService({ jitterRng: new SeededRandom(seed).stream('retry.jitter') });

describe('classifyFailure', () => {
  it('treats no-answer and busy as transient — the ordinary reasons to call back', () => {
    expect(classifyFailure({ outcome: 'NO_ANSWER', failureCode: null })).toBe('TRANSIENT');
    expect(classifyFailure({ outcome: 'BUSY', failureCode: null })).toBe('TRANSIENT');
  });

  it('treats timeouts and abandonment as transient', () => {
    expect(classifyFailure({ outcome: 'TIMEOUT', failureCode: 'PROVIDER_TIMEOUT' })).toBe('TRANSIENT');
    expect(classifyFailure({ outcome: 'ABANDONED', failureCode: null })).toBe('TRANSIENT');
  });

  it('treats an answered call as no failure at all', () => {
    expect(classifyFailure({ outcome: 'ANSWERED', failureCode: null })).toBe('NONE');
  });

  it('treats an invalid number as permanent', () => {
    // Retrying an unroutable number burns a contact's attempts for nothing.
    expect(classifyFailure({ outcome: 'FAILED', failureCode: 'INVALID_PHONE_NUMBER' })).toBe(
      'PERMANENT',
    );
    expect(classifyFailure({ outcome: 'FAILED', failureCode: 'UNSUPPORTED_DESTINATION' })).toBe(
      'PERMANENT',
    );
  });

  it('treats provider errors and outages as transient', () => {
    for (const code of ['PROVIDER_ERROR', 'PROVIDER_TIMEOUT', 'PROVIDER_OUTAGE']) {
      expect(classifyFailure({ outcome: 'FAILED', failureCode: code }), code).toBe('TRANSIENT');
    }
  });

  it('treats deliberate cancellation as permanent', () => {
    // A call cancelled by an operator or an emergency stop must not come back on its own.
    expect(classifyFailure({ outcome: 'CANCELLED', failureCode: null })).toBe('PERMANENT');
  });

  it('defaults an unrecognised failure to permanent', () => {
    // The safe default is to stop: an unbounded retry loop against a failure nobody
    // understands is worse than losing one contact.
    expect(classifyFailure({ outcome: 'FAILED', failureCode: 'SOMETHING_NEW' })).toBe('PERMANENT');
    expect(classifyFailure({ outcome: 'FAILED', failureCode: null })).toBe('PERMANENT');
  });
});

describe('RetryService.decide', () => {
  const campaign = makeCampaign();

  it('schedules a retry for a transient failure with attempts remaining', () => {
    const decision = service().decide({
      campaign,
      failureClass: 'TRANSIENT',
      failureCode: 'PROVIDER_TIMEOUT',
      attemptCount: 1,
      now: 10_000,
    });

    expect(decision.retry).toBe(true);
    expect(decision.delayMs).toBeGreaterThan(0);
    expect(decision.nextAttemptAt).toBe(10_000 + (decision.delayMs ?? 0));
    expect(decision.reason).toContain('attempt 2 of 3');
  });

  it('refuses to retry a permanent failure even with attempts remaining', () => {
    const decision = service().decide({
      campaign,
      failureClass: 'PERMANENT',
      failureCode: 'INVALID_PHONE_NUMBER',
      attemptCount: 1,
      now: 0,
    });

    expect(decision.retry).toBe(false);
    expect(decision.nextAttemptAt).toBeNull();
    expect(decision.reason).toContain('Permanent failure');
  });

  it('stops once every attempt is used', () => {
    const decision = service().decide({
      campaign,
      failureClass: 'TRANSIENT',
      failureCode: 'PROVIDER_TIMEOUT',
      attemptCount: 3,
      now: 0,
    });

    expect(decision.retry).toBe(false);
    expect(decision.code).toBe('MAX_ATTEMPTS_EXCEEDED');
    expect(decision.reason).toContain('All 3 attempts used');
  });

  it('does not retry a success', () => {
    const decision = service().decide({
      campaign,
      failureClass: 'NONE',
      failureCode: null,
      attemptCount: 1,
      now: 0,
    });
    expect(decision.retry).toBe(false);
  });

  it('takes the stricter of the campaign and retry-policy attempt limits', () => {
    // Neither limit can be bypassed by editing only the other.
    const strictCampaign = makeCampaign({
      maxAttemptsPerContact: 2,
      retryPolicy: { ...campaign.retryPolicy, maxAttempts: 10 },
    });
    const decision = service().decide({
      campaign: strictCampaign,
      failureClass: 'TRANSIENT',
      failureCode: 'PROVIDER_TIMEOUT',
      attemptCount: 2,
      now: 0,
    });

    expect(decision.retry).toBe(false);
    expect(decision.maxAttempts).toBe(2);
  });
});

describe('RetryService.computeBackoff', () => {
  const noJitter = makeCampaign({
    retryPolicy: {
      maxAttempts: 6,
      initialDelayMs: 1000,
      maxDelayMs: 30_000,
      multiplier: 2,
      jitterRatio: 0,
    },
  });

  it('grows exponentially', () => {
    const retry = service();
    expect(retry.computeBackoff(noJitter, 1)).toBe(1000);
    expect(retry.computeBackoff(noJitter, 2)).toBe(2000);
    expect(retry.computeBackoff(noJitter, 3)).toBe(4000);
    expect(retry.computeBackoff(noJitter, 4)).toBe(8000);
  });

  it('caps at the configured maximum', () => {
    const retry = service();
    expect(retry.computeBackoff(noJitter, 10)).toBe(30_000);
    expect(retry.computeBackoff(noJitter, 50)).toBe(30_000);
  });

  it('spreads retries so a batch of failures does not return in lockstep', () => {
    // Jitter is not decoration: an outage fails many contacts at once, and un-jittered
    // backoff would hit the recovering provider with a synchronised burst.
    const jittered = makeCampaign({
      retryPolicy: { ...noJitter.retryPolicy, jitterRatio: 0.5 },
    });
    const retry = service();

    const delays = new Set<number>();
    for (let i = 0; i < 100; i += 1) delays.add(retry.computeBackoff(jittered, 3));

    expect(delays.size).toBeGreaterThan(50);
    for (const delay of delays) {
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(6000);
    }
  });

  it('never exceeds maxDelay even after jitter is applied', () => {
    // A jittered delay above the ceiling would quietly break the policy's stated guarantee.
    const jittered = makeCampaign({
      retryPolicy: {
        maxAttempts: 10,
        initialDelayMs: 30_000,
        maxDelayMs: 30_000,
        multiplier: 2,
        jitterRatio: 0.9,
      },
    });
    const retry = service();
    for (let i = 0; i < 200; i += 1) {
      expect(retry.computeBackoff(jittered, 5)).toBeLessThanOrEqual(30_000);
    }
  });

  it('never returns less than 1ms', () => {
    const tiny = makeCampaign({
      retryPolicy: {
        maxAttempts: 3,
        initialDelayMs: 1,
        maxDelayMs: 10,
        multiplier: 1,
        jitterRatio: 1,
      },
    });
    const retry = service();
    for (let i = 0; i < 100; i += 1) {
      expect(retry.computeBackoff(tiny, 1)).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic for a given seed', () => {
    const jittered = makeCampaign({ retryPolicy: { ...noJitter.retryPolicy, jitterRatio: 0.4 } });
    const first = Array.from({ length: 20 }, (_, i) => service(99).computeBackoff(jittered, i + 1));
    const second = Array.from({ length: 20 }, (_, i) => service(99).computeBackoff(jittered, i + 1));
    expect(first).toEqual(second);
  });
});
