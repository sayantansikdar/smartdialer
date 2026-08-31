/**
 * Central concurrency control.
 *
 * Every call that will exist must first hold a **lease**. There is no other way to occupy a
 * slot, and no module outside this one may increment or decrement a capacity counter
 * (ARCHITECTURE.md, "Concurrency boundary").
 *
 * Two properties do the work:
 *
 * 1. **Acquisition is synchronous and all-or-nothing.** `tryAcquire` checks the global,
 *    campaign and provider limits and increments all three without an `await` anywhere in
 *    between. Node is single-threaded, so no other worker can observe the counters halfway
 *    through. This is the whole reason the check-then-act sequence is safe here — and the
 *    reason it would stop being safe the moment anyone made this method `async`.
 *
 * 2. **Release is idempotent** (DECISIONS.md D-008). A bare `count--` makes a double release
 *    silently corrupt capacity: the counter drifts below the true number of active calls
 *    and the system quietly begins exceeding its limit, with the symptom appearing far from
 *    the cause. A lease that can only be released once turns that into a no-op.
 *
 * Leases also expire. A provider that accepts a call and then goes silent would otherwise
 * hold its slot forever; `sweepExpired` reclaims those, so the engine's watchdog has a
 * backstop even if the watchdog itself is lost.
 */

import type { Clock } from '../core/clock.ts';
import { ERROR_CODES, type ErrorCode } from '../core/errors.ts';

export interface Lease {
  readonly id: string;
  readonly callId: string;
  readonly campaignId: string;
  readonly providerId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  readonly released: boolean;
}

class LeaseRecord implements Lease {
  readonly id: string;
  readonly callId: string;
  readonly campaignId: string;
  readonly providerId: string;
  readonly acquiredAt: number;
  readonly expiresAt: number;
  #released = false;

  constructor(input: {
    id: string;
    callId: string;
    campaignId: string;
    providerId: string;
    acquiredAt: number;
    expiresAt: number;
  }) {
    this.id = input.id;
    this.callId = input.callId;
    this.campaignId = input.campaignId;
    this.providerId = input.providerId;
    this.acquiredAt = input.acquiredAt;
    this.expiresAt = input.expiresAt;
  }

  get released(): boolean {
    return this.#released;
  }

  /** Returns true only for the first call. This is the idempotency guarantee. */
  markReleased(): boolean {
    if (this.#released) return false;
    this.#released = true;
    return true;
  }
}

export interface AcquireRequest {
  readonly callId: string;
  readonly campaignId: string;
  readonly providerId: string;
  /** Campaign-specific ceiling. Always applied alongside the global and provider ceilings. */
  readonly campaignMaxConcurrentCalls: number;
  /** How long before this lease is considered leaked. */
  readonly ttlMs: number;
}

export type AcquireResult =
  | { readonly ok: true; readonly lease: Lease }
  | {
      readonly ok: false;
      readonly code: ErrorCode;
      readonly message: string;
      readonly metadata: Record<string, unknown>;
    };

export interface ConcurrencyCounts {
  readonly global: number;
  readonly byCampaign: Readonly<Record<string, number>>;
  readonly byProvider: Readonly<Record<string, number>>;
}

export interface ConcurrencyServiceOptions {
  readonly clock: Clock;
  readonly globalMaxConcurrentCalls: number;
  readonly providerMaxConcurrentCalls: number;
}

export class ConcurrencyService {
  readonly #clock: Clock;
  readonly #globalMax: number;
  readonly #providerMax: number;

  readonly #leases = new Map<string, LeaseRecord>();
  readonly #byCampaign = new Map<string, number>();
  readonly #byProvider = new Map<string, number>();
  #global = 0;
  #sequence = 0;

  constructor(options: ConcurrencyServiceOptions) {
    this.#clock = options.clock;
    this.#globalMax = options.globalMaxConcurrentCalls;
    this.#providerMax = options.providerMaxConcurrentCalls;
  }

  get globalMax(): number {
    return this.#globalMax;
  }

  get providerMax(): number {
    return this.#providerMax;
  }

  /**
   * Claim a slot in all three scopes, or none.
   *
   * MUST remain synchronous. Every check and every increment happens in one uninterrupted
   * turn of the event loop; introducing an `await` between the checks and the increments
   * would reopen exactly the race this exists to close.
   */
  tryAcquire(request: AcquireRequest): AcquireResult {
    const campaignActive = this.#byCampaign.get(request.campaignId) ?? 0;
    const providerActive = this.#byProvider.get(request.providerId) ?? 0;

    // Checked most-global first, so the reported reason is the most fundamental limit that
    // applies rather than an incidental one.
    if (this.#global >= this.#globalMax) {
      return {
        ok: false,
        code: ERROR_CODES.GLOBAL_CONCURRENCY_LIMIT,
        message: `Global concurrent call limit reached (${this.#globalMax})`,
        metadata: { current: this.#global, maximum: this.#globalMax },
      };
    }
    if (campaignActive >= request.campaignMaxConcurrentCalls) {
      return {
        ok: false,
        code: ERROR_CODES.CAMPAIGN_CONCURRENCY_LIMIT,
        message: `Campaign has reached its maximum concurrent call limit (${request.campaignMaxConcurrentCalls})`,
        metadata: {
          campaignId: request.campaignId,
          currentConcurrency: campaignActive,
          maximumConcurrency: request.campaignMaxConcurrentCalls,
        },
      };
    }
    if (providerActive >= this.#providerMax) {
      return {
        ok: false,
        code: ERROR_CODES.PROVIDER_CONCURRENCY_LIMIT,
        message: `Provider concurrent call limit reached (${this.#providerMax})`,
        metadata: {
          providerId: request.providerId,
          current: providerActive,
          maximum: this.#providerMax,
        },
      };
    }

    const now = this.#clock.now();
    const lease = new LeaseRecord({
      id: `lease_${String(++this.#sequence).padStart(6, '0')}`,
      callId: request.callId,
      campaignId: request.campaignId,
      providerId: request.providerId,
      acquiredAt: now,
      expiresAt: now + request.ttlMs,
    });

    this.#leases.set(lease.id, lease);
    this.#global += 1;
    this.#byCampaign.set(request.campaignId, campaignActive + 1);
    this.#byProvider.set(request.providerId, providerActive + 1);

    return { ok: true, lease };
  }

  /**
   * Give a slot back. Safe to call any number of times with the same lease, and safe to call
   * with a lease this service does not know about — both are no-ops returning false.
   */
  release(lease: Lease): boolean {
    const record = this.#leases.get(lease.id);
    if (record === undefined) return false;
    if (!record.markReleased()) return false;

    this.#leases.delete(record.id);
    this.#global -= 1;
    this.#decrement(this.#byCampaign, record.campaignId);
    this.#decrement(this.#byProvider, record.providerId);
    return true;
  }

  /**
   * Reclaim leases past their expiry.
   *
   * The backstop for a provider that accepts a call and never reports its end. Returns the
   * reclaimed leases so the caller can emit events and mark the corresponding calls — a
   * silent reclamation would hide a genuine fault (CONSTRAINTS.md §3).
   */
  sweepExpired(now: number = this.#clock.now()): Lease[] {
    const expired: LeaseRecord[] = [];
    for (const lease of this.#leases.values()) {
      if (lease.expiresAt <= now) expired.push(lease);
    }
    // Sorted for deterministic ordering of the events this produces.
    expired.sort((a, b) => (a.expiresAt !== b.expiresAt ? a.expiresAt - b.expiresAt : a.id.localeCompare(b.id)));
    for (const lease of expired) this.release(lease);
    return expired;
  }

  #decrement(map: Map<string, number>, key: string): void {
    const next = (map.get(key) ?? 0) - 1;
    if (next <= 0) map.delete(key);
    else map.set(key, next);
  }

  get activeGlobal(): number {
    return this.#global;
  }

  activeForCampaign(campaignId: string): number {
    return this.#byCampaign.get(campaignId) ?? 0;
  }

  activeForProvider(providerId: string): number {
    return this.#byProvider.get(providerId) ?? 0;
  }

  counts(): ConcurrencyCounts {
    return {
      global: this.#global,
      byCampaign: Object.fromEntries(this.#byCampaign),
      byProvider: Object.fromEntries(this.#byProvider),
    };
  }

  /** Live leases, sorted by id. Used by the invariant checker and the debugging endpoints. */
  activeLeases(): readonly Lease[] {
    return [...this.#leases.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  releaseAllForCampaign(campaignId: string): Lease[] {
    const released: LeaseRecord[] = [];
    for (const lease of [...this.#leases.values()]) {
      if (lease.campaignId !== campaignId) continue;
      if (this.release(lease)) released.push(lease);
    }
    return released;
  }

  reset(): void {
    this.#leases.clear();
    this.#byCampaign.clear();
    this.#byProvider.clear();
    this.#global = 0;
    this.#sequence = 0;
  }
}
