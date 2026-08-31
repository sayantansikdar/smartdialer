import { describe, expect, it } from 'vitest';
import { loadConfig, testConfig } from '../../src/config/index.ts';
import { ConfigError, SmartDialerError } from '../../src/core/errors.ts';

const minimal = { SIMULATION_MODE: 'true' };

describe('loadConfig — safety gate', () => {
  it('refuses to start when SIMULATION_MODE is false', () => {
    // The single most important behaviour in the config module. Requiring an explicit
    // affirmative means a stale .env or an inherited environment variable cannot quietly
    // put this process into a mode it was never meant to have (CONSTRAINTS.md §1).
    try {
      loadConfig({ SIMULATION_MODE: 'false' });
      expect.unreachable('should have refused to start');
    } catch (error) {
      const typed = error as SmartDialerError;
      expect(typed.code).toBe('SIMULATION_MODE_REQUIRED');
      expect(typed.message).toContain('refusing to start');
    }
  });

  it('defaults to simulation mode when the variable is absent', () => {
    expect(loadConfig({}).simulationMode).toBe(true);
  });

  it('accepts the usual truthy spellings and rejects nonsense', () => {
    for (const value of ['true', '1', 'yes', 'TRUE', ' Yes ']) {
      expect(loadConfig({ SIMULATION_MODE: value }).simulationMode).toBe(true);
    }
    for (const value of ['no', '0', 'false']) {
      expect(() => loadConfig({ SIMULATION_MODE: value })).toThrow(SmartDialerError);
    }
    expect(() => loadConfig({ SIMULATION_MODE: 'maybe' })).toThrow(ConfigError);
  });

  it('only accepts mock provider drivers', () => {
    expect(loadConfig({ ...minimal, PROVIDER_DRIVER: 'mock' }).providerDriver).toBe('mock');
    expect(loadConfig({ ...minimal, PROVIDER_DRIVER: 'unreliable-mock' }).providerDriver).toBe(
      'unreliable-mock',
    );
    expect(() => loadConfig({ ...minimal, PROVIDER_DRIVER: 'twilio' })).toThrow(ConfigError);
  });
});

describe('loadConfig — validation', () => {
  it('supplies documented defaults', () => {
    const config = loadConfig(minimal);
    expect(config.server.port).toBe(3000);
    expect(config.limits.globalMaxConcurrentCalls).toBe(50);
    expect(config.dialer.defaultMaxAttempts).toBe(3);
    expect(config.predictive.maxAbandonRate).toBe(0.03);
    expect(config.simulation.seed).toBe(12_345);
  });

  it('coerces numeric strings', () => {
    const config = loadConfig({ ...minimal, PORT: '8080', GLOBAL_MAX_CONCURRENT_CALLS: '12' });
    expect(config.server.port).toBe(8080);
    expect(config.limits.globalMaxConcurrentCalls).toBe(12);
  });

  it('rejects nonsensical values rather than defaulting', () => {
    const cases: Array<[string, string]> = [
      ['GLOBAL_MAX_CONCURRENT_CALLS', '-1'],
      ['GLOBAL_MAX_CONCURRENT_CALLS', '0'],
      ['GLOBAL_MAX_CONCURRENT_CALLS', 'lots'],
      ['DEFAULT_MAX_ATTEMPTS', '0'],
      ['GLOBAL_CALLS_PER_SECOND', '-5'],
      ['MAX_ABANDON_RATE', '1.5'],
      ['PREDICTIVE_TARGET_OCCUPANCY', '-0.1'],
      ['PORT', '70000'],
      ['SIMULATION_SPEED', '0'],
      ['LOG_LEVEL', 'chatty'],
    ];
    for (const [key, value] of cases) {
      expect(() => loadConfig({ ...minimal, [key]: value }), `${key}=${value}`).toThrow(ConfigError);
    }
  });

  it('names the offending variable in the error', () => {
    try {
      loadConfig({ ...minimal, GLOBAL_MAX_CONCURRENT_CALLS: '-1' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as ConfigError).message).toContain('GLOBAL_MAX_CONCURRENT_CALLS');
    }
  });

  it('catches cross-field combinations that are individually valid', () => {
    expect(() =>
      loadConfig({
        ...minimal,
        DEFAULT_RETRY_INITIAL_DELAY_MS: '60000',
        DEFAULT_RETRY_MAX_DELAY_MS: '30000',
      }),
    ).toThrow(/exceeds DEFAULT_RETRY_MAX_DELAY_MS/);

    expect(() =>
      loadConfig({ ...minimal, ABANDON_TIMEOUT_MS: '50000', PROVIDER_TIMEOUT_MS: '45000' }),
    ).toThrow(/must be well below/);
  });

  it('warns rather than fails when a limit is merely redundant', () => {
    // Safe, because the safety engine always applies the minimum applicable limit — so
    // failing startup here would block legitimate small-limit configurations (the ones
    // tests and demos need most) without preventing any unsafe outcome.
    const config = loadConfig({
      ...minimal,
      PROVIDER_MAX_CONCURRENT_CALLS: '100',
      GLOBAL_MAX_CONCURRENT_CALLS: '50',
    });
    expect(config.warnings).toHaveLength(1);
    expect(config.warnings[0]).toContain('can never bind');
  });

  it('warns about an abandon rate above the usual regulatory ceiling', () => {
    expect(loadConfig({ ...minimal, MAX_ABANDON_RATE: '0.2' }).warnings.join()).toContain(
      'MAX_ABANDON_RATE',
    );
  });

  it('reports no warnings for a sane configuration', () => {
    expect(loadConfig(minimal).warnings).toEqual([]);
  });
});

describe('testConfig', () => {
  it('produces a valid in-memory configuration', () => {
    const config = testConfig();
    expect(config.nodeEnv).toBe('test');
    expect(config.databasePath).toBe(':memory:');
    expect(config.simulationMode).toBe(true);
  });

  it('accepts overrides', () => {
    expect(testConfig({ GLOBAL_MAX_CONCURRENT_CALLS: '3' }).limits.globalMaxConcurrentCalls).toBe(3);
  });
});
