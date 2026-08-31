/**
 * A hash router in thirty lines.
 *
 * The dashboard has nine flat views and one detail route. `react-router` would be a
 * dependency and a concept for something a `hashchange` listener already does — and the hash
 * form means the built dashboard works from a file path or any static host with no server
 * rewrite rules.
 */

import { useEffect, useState } from 'react';

export interface Route {
  readonly view: string;
  readonly param: string | null;
}

/** Exported for testing: parsing is the part with edge cases, and it needs no DOM. */
export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#\/?/, '');
  const [view = '', param] = path.split('/');
  return {
    view: view === '' ? 'dashboard' : view,
    // An empty segment is not a parameter. `#/campaign/` would otherwise route to the detail
    // view with an empty id, which then requests `/api/campaigns/` and 404s — a broken page
    // rather than the campaign list the trailing slash clearly meant.
    param: param === undefined || param === '' ? null : param,
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));

  useEffect(() => {
    const onChange = (): void => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  return route;
}

export function navigate(view: string, param?: string): void {
  window.location.hash = param === undefined ? `#/${view}` : `#/${view}/${param}`;
}
