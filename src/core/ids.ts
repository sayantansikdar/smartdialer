/**
 * Identifier generation.
 *
 * Ids are sequential per prefix rather than random (UUID/crypto), because they appear in
 * persisted events and in the event-stream digest used to prove that two runs with the same
 * seed are identical. A random id would make every run differ trivially and destroy that
 * check (DECISIONS.md D-004).
 *
 * The side benefit is readability: `call_000042` in a log tells you it was the forty-second
 * call of the run, which is exactly what you want when reading an event stream.
 */

export class IdGenerator {
  readonly #counters = new Map<string, number>();
  readonly #width: number;

  constructor(options: { width?: number } = {}) {
    this.#width = options.width ?? 6;
  }

  next(prefix: string): string {
    const current = (this.#counters.get(prefix) ?? 0) + 1;
    this.#counters.set(prefix, current);
    return `${prefix}_${String(current).padStart(this.#width, '0')}`;
  }

  /** How many ids have been issued for a prefix. Used in assertions and reports. */
  count(prefix: string): number {
    return this.#counters.get(prefix) ?? 0;
  }

  /**
   * Continue numbering from an existing high-water mark.
   *
   * Sequential ids are only unique within one process unless somebody tells the generator
   * what the database already holds. On a restart against a persistent database the counter
   * would otherwise reopen at 1 and immediately collide with rows written by the previous
   * run — which fails the insert, and (because events are written on every state transition)
   * takes the dialer down with it. See BUG.md B-005.
   *
   * Only ever moves a counter forward: restoring a lower value than has already been issued
   * in this process would reintroduce the collision it exists to prevent.
   */
  restore(prefix: string, highestIssued: number): void {
    if (!Number.isFinite(highestIssued) || highestIssued <= 0) return;
    const current = this.#counters.get(prefix) ?? 0;
    if (highestIssued > current) this.#counters.set(prefix, Math.floor(highestIssued));
  }

  reset(): void {
    this.#counters.clear();
  }
}

export const ID_PREFIX = {
  campaign: 'camp',
  contact: 'cont',
  agent: 'agent',
  call: 'call',
  attempt: 'att',
  event: 'evt',
  lease: 'lease',
  simulation: 'sim',
} as const;
