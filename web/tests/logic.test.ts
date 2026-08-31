import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateCampaignForm, isValid, type CampaignFormValues } from '../src/lib/validation.ts';
import { parseRoute } from '../src/lib/router.ts';
import { appendBounded } from '../src/lib/events.ts';
import { duration, percent, redactPhone, statusTone, virtualTime } from '../src/lib/format.ts';
import { ApiError, api } from '../src/lib/api.ts';
import type { SmartDialerEvent } from '../src/lib/types.ts';

const validForm: CampaignFormValues = {
  name: 'Test Campaign',
  dialingMode: 'PROGRESSIVE',
  maxConcurrentCalls: '8',
  maxCallsPerSecond: '4',
  maxAbandonRate: '0.03',
  maxAttemptsPerContact: '3',
};

describe('Campaign form validation', () => {
  it('accepts a sane configuration', () => {
    expect(isValid(validateCampaignForm(validForm))).toBe(true);
  });

  it('rejects every unsafe configuration the server also rejects', () => {
    // These mirror the API tests one-for-one. The point is not that the browser is the
    // guardrail — the server is — but that the two agree, so a valid-looking form cannot
    // produce a rejected request.
    const cases: Array<[string, Partial<CampaignFormValues>, keyof CampaignFormValues]> = [
      ['empty name', { name: '   ' }, 'name'],
      ['negative concurrency', { maxConcurrentCalls: '-1' }, 'maxConcurrentCalls'],
      ['zero concurrency', { maxConcurrentCalls: '0' }, 'maxConcurrentCalls'],
      ['fractional concurrency', { maxConcurrentCalls: '2.5' }, 'maxConcurrentCalls'],
      ['non-numeric concurrency', { maxConcurrentCalls: 'lots' }, 'maxConcurrentCalls'],
      ['zero rate', { maxCallsPerSecond: '0' }, 'maxCallsPerSecond'],
      ['negative rate', { maxCallsPerSecond: '-5' }, 'maxCallsPerSecond'],
      ['abandon rate above 1', { maxAbandonRate: '1.5' }, 'maxAbandonRate'],
      ['abandon rate below 0', { maxAbandonRate: '-0.1' }, 'maxAbandonRate'],
      ['zero attempts', { maxAttemptsPerContact: '0' }, 'maxAttemptsPerContact'],
      ['fractional attempts', { maxAttemptsPerContact: '1.5' }, 'maxAttemptsPerContact'],
    ];

    for (const [label, patch, field] of cases) {
      const errors = validateCampaignForm({ ...validForm, ...patch });
      expect(isValid(errors), label).toBe(false);
      expect(errors[field], label).toBeDefined();
    }
  });

  it('catches an abandon rate entered as a percentage', () => {
    // Typing "3" meaning 3% would otherwise request a 300% abandon rate. Worth its own test
    // because it is the single most plausible operator mistake on this form.
    const errors = validateCampaignForm({ ...validForm, maxAbandonRate: '3' });
    expect(errors.maxAbandonRate).toContain('0.03 = 3%');
  });

  it('accepts the boundary values', () => {
    expect(isValid(validateCampaignForm({ ...validForm, maxAbandonRate: '0' }))).toBe(true);
    expect(isValid(validateCampaignForm({ ...validForm, maxAbandonRate: '1' }))).toBe(true);
    expect(isValid(validateCampaignForm({ ...validForm, maxConcurrentCalls: '1' }))).toBe(true);
    expect(isValid(validateCampaignForm({ ...validForm, maxAttemptsPerContact: '1' }))).toBe(true);
  });

  it('reports every problem at once rather than one at a time', () => {
    const errors = validateCampaignForm({
      ...validForm,
      name: '',
      maxConcurrentCalls: '0',
      maxAttemptsPerContact: '0',
    });
    expect(Object.keys(errors)).toHaveLength(3);
  });
});

describe('Route parsing', () => {
  it('defaults to the dashboard', () => {
    for (const hash of ['', '#', '#/', '#//']) {
      expect(parseRoute(hash), hash).toEqual({ view: 'dashboard', param: null });
    }
  });

  it('parses a flat view', () => {
    expect(parseRoute('#/campaigns')).toEqual({ view: 'campaigns', param: null });
    expect(parseRoute('campaigns')).toEqual({ view: 'campaigns', param: null });
  });

  it('parses a detail route with its id', () => {
    expect(parseRoute('#/campaign/camp_000001')).toEqual({
      view: 'campaign',
      param: 'camp_000001',
    });
  });

  it('ignores anything beyond the first parameter', () => {
    expect(parseRoute('#/campaign/camp_1/extra/junk')).toEqual({
      view: 'campaign',
      param: 'camp_1',
    });
  });
});

describe('Bounded event buffer', () => {
  const event = (id: string): SmartDialerEvent => ({
    id, type: 'call.created', at: 0, severity: 'info', message: id, metadata: {},
  });

  it('puts the newest event first', () => {
    const result = appendBounded([event('a')], event('b'));
    expect(result.map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('never grows past the cap', () => {
    // A tab left open for an hour would otherwise accumulate every event ever emitted.
    let buffer: SmartDialerEvent[] = [];
    for (let i = 0; i < 750; i += 1) buffer = appendBounded(buffer, event(`e${i}`), 500);

    expect(buffer).toHaveLength(500);
    expect(buffer[0]?.id).toBe('e749');
    expect(buffer.at(-1)?.id).toBe('e250');
  });

  it('does not mutate the array it was given', () => {
    const original = [event('a')];
    appendBounded(original, event('b'));
    expect(original).toHaveLength(1);
  });
});

describe('Formatting', () => {
  it('renders virtual time as elapsed simulated duration, not a clock time', () => {
    // Rendering these as wall-clock times would be a lie: at 10x speed the dashboard's "now"
    // has nothing to do with the viewer's.
    expect(virtualTime(0)).toBe('0:00');
    expect(virtualTime(65_000)).toBe('1:05');
    expect(virtualTime(3_725_000)).toBe('1:02:05');
    expect(virtualTime(-100)).toBe('0:00');
  });

  it('scales durations to a readable unit', () => {
    expect(duration(null)).toBe('—');
    expect(duration(0)).toBe('—');
    expect(duration(450)).toBe('450ms');
    expect(duration(1500)).toBe('1.5s');
    expect(duration(125_000)).toBe('2m 5s');
  });

  it('formats percentages', () => {
    expect(percent(0.0325)).toBe('3.3%');
    expect(percent(0.5, 0)).toBe('50%');
    expect(percent(0)).toBe('0.0%');
  });

  it('redacts phone numbers the same way the server logs them', () => {
    expect(redactPhone('+15550100')).toBe('+******00');
    expect(redactPhone('+1-555-0142')).toBe('+******42');
    // Two numbers of the same length ending in the same digits must be indistinguishable —
    // otherwise the "redaction" still leaks the number.
    expect(redactPhone('+15550142')).toBe(redactPhone('+19995542'));
  });

  it('never returns a phone number unchanged', () => {
    for (const number of ['+15550100', '5550123', '+1-555-0199']) {
      expect(redactPhone(number)).not.toBe(number);
      expect(redactPhone(number)).toContain('*');
    }
  });

  it('maps statuses to tones without ever relying on colour alone', () => {
    // Colour is a secondary signal — every badge also shows its label — but the mapping must
    // still be sensible and total.
    expect(statusTone('RUNNING')).toBe('ok');
    expect(statusTone('DO_NOT_CALL')).toBe('danger');
    expect(statusTone('TIMEOUT')).toBe('danger');
    expect(statusTone('PAUSED')).toBe('warn');
    expect(statusTone('DRAFT')).toBe('muted');
    expect(statusTone('SOMETHING_NEW')).toBe('muted');
  });
});

describe('API client error handling', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const mockFetch = (status: number, body: unknown): void => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    ) as unknown as typeof fetch;
  };

  it('returns the parsed body on success', async () => {
    mockFetch(200, { campaigns: [{ id: 'camp_1' }] });
    await expect(api.campaigns()).resolves.toEqual({ campaigns: [{ id: 'camp_1' }] });
  });

  it('preserves the server error code and metadata', async () => {
    // The whole reason for a typed client: the UI branches on the code and shows the
    // metadata, so "CAMPAIGN_CONCURRENCY_LIMIT with current 10 of 10" survives to the screen.
    mockFetch(409, {
      error: {
        code: 'CAMPAIGN_CONCURRENCY_LIMIT',
        message: 'Campaign has reached its maximum concurrent call limit.',
        metadata: { currentConcurrency: 10, maximumConcurrency: 10 },
      },
    });

    await expect(api.campaignAction('camp_1', 'start')).rejects.toThrow(ApiError);
    await api.campaignAction('camp_1', 'start').catch((error: unknown) => {
      const typed = error as ApiError;
      expect(typed.code).toBe('CAMPAIGN_CONCURRENCY_LIMIT');
      expect(typed.status).toBe(409);
      expect(typed.metadata).toEqual({ currentConcurrency: 10, maximumConcurrency: 10 });
    });
  });

  it('degrades gracefully when the server sends an unshaped error', async () => {
    mockFetch(500, { unexpected: true });
    await api.campaigns().catch((error: unknown) => {
      const typed = error as ApiError;
      expect(typed.code).toBe('UNKNOWN');
      expect(typed.message).toContain('500');
    });
  });

  it('explains an unreachable API instead of surfacing "Failed to fetch"', async () => {
    // The single most likely failure in local development, and the least informative default
    // message in the browser.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await api.systemStatus().catch((error: unknown) => {
      const typed = error as ApiError;
      expect(typed.code).toBe('NETWORK_ERROR');
      expect(typed.message).toContain('npm run dev');
      expect(typed.status).toBe(0);
    });
  });

  it('handles an empty response body', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 200 })) as unknown as typeof fetch;
    await expect(api.emergencyResume()).resolves.toEqual({});
  });

  it('drops empty query parameters rather than sending blanks', async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ contacts: [] }), { status: 200 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    await api.contacts({ campaignId: 'camp_1', status: undefined, query: '', limit: 50 });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('campaignId=camp_1');
    expect(url).toContain('limit=50');
    expect(url).not.toContain('status=');
    expect(url).not.toContain('query=');
  });

  it('encodes parameters that would otherwise break the URL', async () => {
    const spy = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ contacts: [] }), { status: 200 }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    await api.contacts({ query: 'a&b=c d' });
    expect(String(spy.mock.calls[0]?.[0])).toContain('query=a%26b%3Dc%20d');
  });
});
