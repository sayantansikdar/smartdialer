/**
 * Constructs and owns provider instances.
 *
 * This is the choke point that makes CONSTRAINTS.md §1 enforceable rather than aspirational:
 * `create` accepts only the two mock drivers, and there is no branch that could construct
 * anything capable of reaching a real carrier. Adding one would require editing this
 * function, the `PROVIDER_DRIVERS` list in config, and passing review — which is exactly the
 * amount of friction that decision deserves.
 */

import type { Clock } from '../core/clock.ts';
import { ERROR_CODES, SmartDialerError } from '../core/errors.ts';
import type { SeededRandom } from '../core/rng.ts';
import type { ProviderDriver } from '../config/index.ts';
import { MockTelecomProvider, type MockProviderConfig } from './mock-provider.ts';
import { UnreliableMockTelecomProvider } from './unreliable-mock-provider.ts';
import type { TelecomProvider } from './telecom-provider.ts';

export interface CreateProviderOptions {
  readonly id: string;
  readonly driver: ProviderDriver;
  readonly clock: Clock;
  readonly random: SeededRandom;
  readonly config?: Partial<MockProviderConfig>;
}

export function createProvider(options: CreateProviderOptions): MockTelecomProvider {
  const base = {
    id: options.id,
    clock: options.clock,
    random: options.random,
    ...(options.config === undefined ? {} : { config: options.config }),
  };

  switch (options.driver) {
    case 'mock':
      return new MockTelecomProvider(base);
    case 'unreliable-mock':
      return new UnreliableMockTelecomProvider(base);
    default: {
      // Unreachable while `ProviderDriver` stays a closed union — but a runtime guard as
      // well as a compile-time one, because this is the boundary that keeps the system
      // incapable of placing a real call.
      const exhaustive: never = options.driver;
      throw new SmartDialerError(
        ERROR_CODES.UNKNOWN_PROVIDER_DRIVER,
        `Unknown provider driver: ${String(exhaustive)}. Only mock drivers exist.`,
        { metadata: { driver: exhaustive } },
      );
    }
  }
}

export class ProviderRegistry {
  readonly #providers = new Map<string, MockTelecomProvider>();

  register(provider: MockTelecomProvider): void {
    this.#providers.set(provider.id, provider);
  }

  get(id: string): TelecomProvider {
    const provider = this.#providers.get(id);
    if (provider === undefined) {
      throw new SmartDialerError(
        ERROR_CODES.NOT_FOUND,
        `No provider registered with id "${id}"`,
        { metadata: { providerId: id, known: [...this.#providers.keys()] }, httpStatus: 404 },
      );
    }
    return provider;
  }

  /** Typed access for the failure-injection endpoints, which need `updateConfig`. */
  getMock(id: string): MockTelecomProvider {
    return this.get(id) as MockTelecomProvider;
  }

  has(id: string): boolean {
    return this.#providers.has(id);
  }

  list(): MockTelecomProvider[] {
    return [...this.#providers.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  resetAll(): void {
    for (const provider of this.#providers.values()) provider.reset();
  }
}
