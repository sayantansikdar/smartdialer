/**
 * A tiny explicit state machine.
 *
 * The domain has four of these (Call, Agent, Campaign, Contact). They exist because status
 * fields that anyone can assign to drift: a call ends up CONNECTED without ever having
 * RINGed, an agent is ON_CALL for a call that already ended, and the concurrency ledger
 * quietly stops matching reality. Making the legal transitions an explicit, testable data
 * structure turns those bugs into loud failures at the moment they happen.
 *
 * Illegal transitions throw (see `InvalidTransitionError`) rather than returning false,
 * because reaching one means a caller's model of the world is already wrong.
 *
 * This deliberately does NOT own side effects. Deciding whether a transition is legal and
 * deciding what should happen because of it are different jobs; services own the second.
 */

import { InvalidTransitionError } from './errors.ts';

export interface StateMachineSpec<S extends string> {
  /** Used in error messages and events, e.g. "Call". */
  readonly name: string;
  readonly initial: S;
  /** For each state, the states it may move to. A state with `[]` is a sink. */
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  /** States from which nothing further happens. Used by invariants and metrics. */
  readonly terminal?: readonly S[];
}

export class StateMachine<S extends string> {
  readonly name: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly #transitions: Readonly<Record<S, readonly S[]>>;
  readonly #terminal: ReadonlySet<S>;

  constructor(spec: StateMachineSpec<S>) {
    this.name = spec.name;
    this.initial = spec.initial;
    this.#transitions = spec.transitions;
    this.states = Object.keys(spec.transitions) as S[];
    this.#terminal = new Set(spec.terminal ?? []);

    // Fail at construction, not at the first bad transition in production: a typo in a
    // target state would otherwise sit dormant until that path happened to be exercised.
    for (const [from, targets] of Object.entries(spec.transitions) as [S, readonly S[]][]) {
      for (const to of targets) {
        if (!(to in spec.transitions)) {
          throw new Error(
            `${spec.name} state machine: transition ${from} -> ${to} names an unknown state`,
          );
        }
      }
    }
    if (!(spec.initial in spec.transitions)) {
      throw new Error(`${spec.name} state machine: initial state ${spec.initial} is not defined`);
    }
  }

  can(from: S, to: S): boolean {
    return this.#transitions[from]?.includes(to) ?? false;
  }

  /** Throws `InvalidTransitionError` unless `from -> to` is legal. */
  assertCan(from: S, to: S, entityId?: string): void {
    if (!this.can(from, to)) {
      throw new InvalidTransitionError(this.name, from, to, entityId);
    }
  }

  isTerminal(state: S): boolean {
    return this.#terminal.has(state);
  }

  targetsFrom(state: S): readonly S[] {
    return this.#transitions[state] ?? [];
  }

  isState(value: string): value is S {
    return value in this.#transitions;
  }

  /** Human-readable dump, used by docs and when debugging an unexpected transition. */
  describe(): string {
    return this.states
      .map((state) => {
        const targets = this.targetsFrom(state);
        const suffix = this.isTerminal(state) ? ' [terminal]' : '';
        return `  ${state}${suffix} -> ${targets.length > 0 ? targets.join(', ') : '(none)'}`;
      })
      .join('\n');
  }
}
