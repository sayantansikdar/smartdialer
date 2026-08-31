import { describe, expect, it } from 'vitest';
import { SimulatedClock } from '../../src/core/clock.ts';
import {
  ERROR_CODES,
  InvalidTransitionError,
  NotFoundError,
  ProviderCallError,
  SmartDialerError,
  isSmartDialerError,
  toSerializedError,
} from '../../src/core/errors.ts';
import { ID_PREFIX, IdGenerator } from '../../src/core/ids.ts';
import { createLogger, createSilentLogger, type LogLevel } from '../../src/core/logger.ts';
import { redactPhoneNumber } from '../../src/core/redact.ts';

describe('IdGenerator', () => {
  it('produces sequential, zero-padded, prefixed ids', () => {
    const ids = new IdGenerator();
    expect(ids.next(ID_PREFIX.call)).toBe('call_000001');
    expect(ids.next(ID_PREFIX.call)).toBe('call_000002');
  });

  it('keeps a separate counter per prefix', () => {
    const ids = new IdGenerator();
    ids.next('call');
    ids.next('call');
    expect(ids.next('agent')).toBe('agent_000001');
    expect(ids.count('call')).toBe(2);
    expect(ids.count('nothing')).toBe(0);
  });

  it('is deterministic across generators, which is what keeps replay comparable', () => {
    const a = new IdGenerator();
    const b = new IdGenerator();
    const seqA = Array.from({ length: 5 }, () => a.next('call'));
    const seqB = Array.from({ length: 5 }, () => b.next('call'));
    expect(seqA).toEqual(seqB);
  });

  it('resets', () => {
    const ids = new IdGenerator();
    ids.next('call');
    ids.reset();
    expect(ids.next('call')).toBe('call_000001');
  });
});

describe('redactPhoneNumber', () => {
  it('masks everything but the last two digits', () => {
    expect(redactPhoneNumber('+15550100')).toBe('+******00');
    expect(redactPhoneNumber('+1-555-0142')).toBe('+******42');
    expect(redactPhoneNumber('5550123')).toBe('*****23');
  });

  it('is not enough on its own to identify a number', () => {
    // Two different numbers of the same length ending in the same two digits must redact
    // to the same string. If they did not, the output would still be leaking the number.
    expect(redactPhoneNumber('+15550142')).toBe(redactPhoneNumber('+19995542'));
  });

  it('handles short and empty input without leaking it', () => {
    expect(redactPhoneNumber('12')).toBe('**');
    expect(redactPhoneNumber('')).toBe('');
    expect(redactPhoneNumber('   ')).toBe('');
  });

  it('never returns the original number for a realistic input', () => {
    for (const number of ['+15550100', '+1-555-0199', '5550123']) {
      expect(redactPhoneNumber(number)).not.toBe(number);
      expect(redactPhoneNumber(number)).toContain('*');
    }
  });
});

describe('errors', () => {
  it('carries a code, metadata and an http status', () => {
    const error = new SmartDialerError(ERROR_CODES.CONFLICT, 'nope', {
      metadata: { campaignId: 'camp_1' },
      httpStatus: 409,
    });
    expect(error.code).toBe('CONFLICT');
    expect(error.httpStatus).toBe(409);
    expect(error.toJSON()).toEqual({
      code: 'CONFLICT',
      message: 'nope',
      metadata: { campaignId: 'camp_1' },
    });
  });

  it('names subclasses correctly and stays instanceof Error', () => {
    const error = new NotFoundError('Campaign', 'camp_9');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SmartDialerError);
    expect(error.name).toBe('NotFoundError');
    expect(error.httpStatus).toBe(404);
    expect(error.message).toBe('Campaign not found: camp_9');
  });

  it('records transience on provider errors, which drives retry eligibility', () => {
    const transient = new ProviderCallError(ERROR_CODES.PROVIDER_TIMEOUT, 'timed out', {
      transient: true,
    });
    const permanent = new ProviderCallError(ERROR_CODES.INVALID_PHONE_NUMBER, 'bad number', {
      transient: false,
    });
    expect(transient.transient).toBe(true);
    expect(permanent.transient).toBe(false);
    expect(transient.metadata['transient']).toBe(true);
  });

  it('narrows with isSmartDialerError', () => {
    expect(isSmartDialerError(new InvalidTransitionError('Call', 'A', 'B'))).toBe(true);
    expect(isSmartDialerError(new Error('plain'))).toBe(false);
    expect(isSmartDialerError('a string')).toBe(false);
  });

  it('serialises anything thrown without losing information', () => {
    expect(toSerializedError(new NotFoundError('Agent', 'a1')).code).toBe('NOT_FOUND');
    expect(toSerializedError(new Error('plain'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'plain',
      metadata: { name: 'Error' },
    });
    expect(toSerializedError('just a string')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'just a string',
      metadata: {},
    });
  });
});

describe('logger', () => {
  const capture = (
    level: LogLevel,
  ): { lines: Array<Record<string, unknown>>; clock: SimulatedClock; log: ReturnType<typeof createLogger> } => {
    const lines: Array<Record<string, unknown>> = [];
    const clock = new SimulatedClock();
    const log = createLogger({
      level,
      clock,
      epochMs: Date.parse('2026-01-01T09:00:00.000Z'),
      sink: (_level, line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });
    return { lines, clock, log };
  };

  it('writes structured JSON with virtual time from the clock', () => {
    const { lines, clock, log } = capture('debug');
    clock.advanceBy(1500);
    log.info('call answered', { callId: 'call_000001' });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      message: 'call answered',
      callId: 'call_000001',
      virtualMs: 1500,
      timestamp: '2026-01-01T09:00:01.500Z',
    });
  });

  it('filters below the configured level', () => {
    const { lines, log } = capture('warn');
    log.debug('noise');
    log.info('noise');
    log.warn('kept');
    log.error('kept');
    expect(lines.map((l) => l['level'])).toEqual(['warn', 'error']);
  });

  it('merges child fields into every line', () => {
    const { lines, log } = capture('debug');
    const child = log.child({ campaignId: 'camp_1' });
    child.info('one', { callId: 'call_1' });
    child.child({ agentId: 'agent_1' }).info('two');

    expect(lines[0]).toMatchObject({ campaignId: 'camp_1', callId: 'call_1' });
    expect(lines[1]).toMatchObject({ campaignId: 'camp_1', agentId: 'agent_1' });
  });

  it('lets explicit fields override inherited ones', () => {
    const { lines, log } = capture('debug');
    log.child({ campaignId: 'camp_1' }).info('x', { campaignId: 'camp_2' });
    expect(lines[0]).toMatchObject({ campaignId: 'camp_2' });
  });

  it('silent logger discards everything and still supports child()', () => {
    const silent = createSilentLogger();
    expect(() => silent.child({ callId: 'x' }).error('ignored')).not.toThrow();
  });
});
