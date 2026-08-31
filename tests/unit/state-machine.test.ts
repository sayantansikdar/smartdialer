import { describe, expect, it } from 'vitest';
import { InvalidTransitionError } from '../../src/core/errors.ts';
import { StateMachine } from '../../src/core/state-machine.ts';

type Light = 'RED' | 'GREEN' | 'YELLOW' | 'BROKEN';

const light = new StateMachine<Light>({
  name: 'Light',
  initial: 'RED',
  transitions: {
    RED: ['GREEN', 'BROKEN'],
    GREEN: ['YELLOW', 'BROKEN'],
    YELLOW: ['RED', 'BROKEN'],
    BROKEN: [],
  },
  terminal: ['BROKEN'],
});

describe('StateMachine', () => {
  it('allows declared transitions', () => {
    expect(light.can('RED', 'GREEN')).toBe(true);
    expect(light.can('GREEN', 'YELLOW')).toBe(true);
    expect(light.can('YELLOW', 'RED')).toBe(true);
  });

  it('rejects undeclared transitions', () => {
    expect(light.can('RED', 'YELLOW')).toBe(false);
    expect(light.can('GREEN', 'RED')).toBe(false);
    expect(light.can('BROKEN', 'RED')).toBe(false);
  });

  it('throws a structured error on an illegal transition', () => {
    // Throwing rather than returning false is deliberate: reaching here means a caller's
    // model of the world is already wrong, and continuing would let call, agent and
    // concurrency state drift apart (CONSTRAINTS.md §3).
    expect(() => light.assertCan('RED', 'YELLOW', 'light_1')).toThrow(InvalidTransitionError);

    try {
      light.assertCan('RED', 'YELLOW', 'light_1');
      expect.unreachable('should have thrown');
    } catch (error) {
      const typed = error as InvalidTransitionError;
      expect(typed.code).toBe('INVALID_STATE_TRANSITION');
      expect(typed.message).toContain('Light: illegal transition RED -> YELLOW');
      expect(typed.metadata).toMatchObject({
        machine: 'Light',
        from: 'RED',
        to: 'YELLOW',
        entityId: 'light_1',
      });
    }
  });

  it('does not throw on a legal transition', () => {
    expect(() => light.assertCan('RED', 'GREEN')).not.toThrow();
  });

  it('identifies terminal states', () => {
    expect(light.isTerminal('BROKEN')).toBe(true);
    expect(light.isTerminal('RED')).toBe(false);
    expect(light.targetsFrom('BROKEN')).toEqual([]);
  });

  it('exposes its states and validates membership', () => {
    expect([...light.states].sort()).toEqual(['BROKEN', 'GREEN', 'RED', 'YELLOW']);
    expect(light.isState('RED')).toBe(true);
    expect(light.isState('PURPLE')).toBe(false);
  });

  it('rejects a definition naming an unknown target state at construction time', () => {
    // Fail when the machine is defined, not the first time that path happens to run.
    expect(
      () =>
        new StateMachine<'A'>({
          name: 'Broken',
          initial: 'A',
          transitions: { A: ['B'] } as unknown as Record<'A', readonly 'A'[]>,
        }),
    ).toThrow(/unknown state/);
  });

  it('rejects a definition whose initial state is undefined', () => {
    expect(
      () =>
        new StateMachine<'A' | 'B'>({
          name: 'Broken',
          initial: 'B',
          transitions: { A: [] } as unknown as Record<'A' | 'B', readonly ('A' | 'B')[]>,
        }),
    ).toThrow(/initial state/);
  });

  it('describes itself for debugging', () => {
    const description = light.describe();
    expect(description).toContain('RED -> GREEN, BROKEN');
    expect(description).toContain('BROKEN [terminal] -> (none)');
  });
});
