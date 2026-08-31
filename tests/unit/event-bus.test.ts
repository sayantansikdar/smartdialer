import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../src/core/event-bus.ts';

interface TestEvent {
  readonly type: 'call.created' | 'call.answered' | 'agent.available';
  readonly payload?: string;
}

describe('EventBus', () => {
  it('delivers every event to global subscribers', () => {
    const bus = new EventBus<TestEvent>();
    const seen: TestEvent[] = [];
    bus.subscribe((event) => seen.push(event));

    bus.emit({ type: 'call.created' });
    bus.emit({ type: 'agent.available' });

    expect(seen.map((e) => e.type)).toEqual(['call.created', 'agent.available']);
  });

  it('delivers only matching events to typed subscribers', () => {
    const bus = new EventBus<TestEvent>();
    const answered: TestEvent[] = [];
    bus.on('call.answered', (event) => answered.push(event));

    bus.emit({ type: 'call.created' });
    bus.emit({ type: 'call.answered', payload: 'x' });

    expect(answered).toEqual([{ type: 'call.answered', payload: 'x' }]);
  });

  it('runs global subscribers before typed ones, consistently', () => {
    const bus = new EventBus<TestEvent>();
    const order: string[] = [];
    bus.subscribe(() => order.push('global'));
    bus.on('call.created', () => order.push('typed'));

    bus.emit({ type: 'call.created' });

    expect(order).toEqual(['global', 'typed']);
  });

  it('unsubscribes cleanly and reports handler count', () => {
    const bus = new EventBus<TestEvent>();
    const seen: string[] = [];
    const offAll = bus.subscribe(() => seen.push('all'));
    const offOne = bus.on('call.created', () => seen.push('one'));
    expect(bus.handlerCount).toBe(2);

    offAll();
    offOne();
    expect(bus.handlerCount).toBe(0);

    bus.emit({ type: 'call.created' });
    expect(seen).toEqual([]);
  });

  it('does not deliver to a handler subscribed during dispatch of the same event', () => {
    // Dispatching over a snapshot keeps ordering independent of subscription timing —
    // otherwise a late subscriber could see a partial view and replay would diverge.
    const bus = new EventBus<TestEvent>();
    const late: string[] = [];
    bus.subscribe(() => {
      bus.subscribe(() => late.push('late'));
    });

    bus.emit({ type: 'call.created' });
    expect(late).toEqual([]);

    bus.emit({ type: 'call.created' });
    expect(late.length).toBeGreaterThan(0);
  });

  it('survives a handler unsubscribing itself mid-dispatch', () => {
    const bus = new EventBus<TestEvent>();
    const seen: string[] = [];
    const off = bus.subscribe(() => {
      seen.push('first');
      off();
    });
    bus.subscribe(() => seen.push('second'));

    bus.emit({ type: 'call.created' });
    bus.emit({ type: 'call.created' });

    expect(seen).toEqual(['first', 'second', 'second']);
  });

  it('keeps calling other handlers when one throws, then reports the failure', () => {
    // Persistence, the SSE broadcaster and the invariant checker all subscribe here. One
    // failing must not starve the others — but it must not be swallowed either.
    const bus = new EventBus<TestEvent>();
    const survived: string[] = [];
    bus.subscribe(() => {
      throw new Error('subscriber blew up');
    });
    bus.subscribe(() => survived.push('still ran'));

    expect(() => bus.emit({ type: 'call.created' })).toThrow('subscriber blew up');
    expect(survived).toEqual(['still ran']);
  });

  it('aggregates multiple handler failures', () => {
    const bus = new EventBus<TestEvent>();
    bus.subscribe(() => {
      throw new Error('one');
    });
    bus.subscribe(() => {
      throw new Error('two');
    });

    expect(() => bus.emit({ type: 'call.created' })).toThrow(AggregateError);
  });

  it('routes handler failures to onHandlerError when provided', () => {
    const onHandlerError = vi.fn();
    const bus = new EventBus<TestEvent>({ onHandlerError });
    bus.subscribe(() => {
      throw new Error('recorded, not thrown');
    });

    expect(() => bus.emit({ type: 'call.created' })).not.toThrow();
    expect(onHandlerError).toHaveBeenCalledTimes(1);
    expect(onHandlerError.mock.calls[0]?.[1]).toEqual({ type: 'call.created' });
  });

  it('removeAll clears every subscription', () => {
    const bus = new EventBus<TestEvent>();
    bus.subscribe(() => {});
    bus.on('call.created', () => {});
    bus.removeAll();
    expect(bus.handlerCount).toBe(0);
  });
});
