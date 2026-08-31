/**
 * Data-loading hooks.
 *
 * Deliberately minimal — no query library. The dashboard's data is either polled on a short
 * interval or pushed over SSE, so caching and revalidation logic would sit unused.
 *
 * `usePolled` is the workhorse. Note that it polls even though SSE exists: the event stream
 * carries *transitions*, while these endpoints return *aggregates*. Recomputing every metric
 * in the browser from an event feed would duplicate the metrics service and be wrong the
 * moment the two drifted.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from './api.ts';

export interface Loadable<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  reload: () => void;
}

export function usePolled<T>(
  load: () => Promise<T>,
  intervalMs: number,
  deps: readonly unknown[] = [],
): Loadable<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  // Held in a ref so the polling effect does not re-subscribe every time the caller passes a
  // freshly-created closure, which would restart the interval on every render.
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;

    const run = async (): Promise<void> => {
      try {
        const result = await loadRef.current();
        if (cancelled) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof ApiError ? caught : new ApiError('UNKNOWN', String(caught), 0, {}));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void run();
    if (intervalMs <= 0) return () => { cancelled = true; };

    const handle = window.setInterval(() => void run(), intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [intervalMs, nonce, ...deps]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

/**
 * Run an action, surfacing its failure rather than swallowing it.
 *
 * Every control in this dashboard calls a real endpoint, so every control can fail in a way
 * the operator needs to see — a campaign refusing to start because it has no agents is
 * information, not noise.
 */
export function useAction(): {
  run: (action: () => Promise<unknown>, onDone?: () => void) => Promise<void>;
  pending: boolean;
  error: ApiError | null;
  clearError: () => void;
} {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async (action: () => Promise<unknown>, onDone?: () => void) => {
    setPending(true);
    setError(null);
    try {
      await action();
      onDone?.();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught : new ApiError('UNKNOWN', String(caught), 0, {}));
    } finally {
      setPending(false);
    }
  }, []);

  return { run, pending, error, clearError: () => setError(null) };
}
