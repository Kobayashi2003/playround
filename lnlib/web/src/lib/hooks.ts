/* The timing this interface is made of.

   A shelf of several thousand covers is only smooth if the work is spaced out
   deliberately: the search box waits for the typing to stop, the scroll
   handler runs once per frame rather than once per event, and a spinner is
   held back long enough that a fast answer never causes a flash of one. */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** The latest value, but only once it has stopped changing for `delay` ms. */
export function useDebounced<T>(value: T, delay = 220): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay, settled]);
  return settled;
}

/** A stable callback that reads the newest closure without re-subscribing. */
export function useEvent<A extends unknown[], R>(fn: (...args: A) => R) {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: A) => ref.current(...args), []);
}

/** Runs `fn` at most once per animation frame, with the newest arguments.

    Scroll fires far more often than the screen is redrawn; coalescing to a
    frame is what keeps the virtual grid's bookkeeping off the critical path. */
export function useRafThrottle<A extends unknown[]>(fn: (...args: A) => void) {
  const latest = useEvent(fn);
  const frame = useRef(0);
  const args = useRef<A | null>(null);

  useEffect(
    () => () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    },
    [],
  );

  return useCallback(
    (...next: A) => {
      args.current = next;
      if (frame.current) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = 0;
        if (args.current) latest(...args.current);
      });
    },
    [latest],
  );
}

/** Runs `fn` no more often than every `ms`, trailing edge included.

    Used where a frame is too eager -- writing reading progress back to the
    server, which should follow the reading rather than lead it. */
export function useThrottle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  const latest = useEvent(fn);
  const last = useRef(0);
  const timer = useRef(0);
  const args = useRef<A | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = 0;
    }
    if (!args.current) return;
    last.current = Date.now();
    const next = args.current;
    args.current = null;
    latest(...next);
  }, [latest]);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const run = useCallback(
    (...next: A) => {
      args.current = next;
      const wait = ms - (Date.now() - last.current);
      if (wait <= 0) {
        flush();
        return;
      }
      if (!timer.current) timer.current = window.setTimeout(flush, wait);
    },
    [flush, ms],
  );

  return [run, flush] as const;
}

/** `true` only once something has been loading for longer than `after` ms.

    Most of what the shelf asks for is already cached or comes back in a few
    milliseconds. Showing a spinner for those makes the interface look busier
    than it is, so the indicator is held back and usually never appears. */
export function useDelayedFlag(active: boolean, after = 180): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = window.setTimeout(() => setShown(true), after);
    return () => window.clearTimeout(timer);
  }, [active, after]);
  return shown && active;
}

/** The usable width of an element, measured on resize and coalesced to a frame.

    It takes the element rather than a ref on purpose. Refs are attached to a
    parent *after* its children's layout effects have run, so a grid measuring
    its scroll container through one reads null on the commit they mount
    together -- which is exactly what happens on the way back from a book, when
    the rows are already cached and there is no loading state in between. */
export function useElementWidth(node: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!node) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const style = getComputedStyle(node);
      const inner =
        node.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      setWidth(current => (Math.abs(current - inner) < 0.5 ? current : inner));
    };
    measure();
    const observer = new ResizeObserver(() => {
      if (frame) return;
      frame = requestAnimationFrame(measure);
    });
    observer.observe(node);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [node]);
  return width;
}

/* ------------------------------------------------------------------ route */
export type Route =
  | {
      readonly view: 'shelf';
      readonly root?: string;
      readonly shelf?: string;
      readonly folder?: string;
      readonly format?: string;
      readonly only?: 'undated' | 'extra' | 'absent';
    }
  | { readonly view: 'book'; readonly id: number }
  | { readonly view: 'read'; readonly id: number }
  | { readonly view: 'reading' }
  | { readonly view: 'folders' }
  | { readonly view: 'formats' }
  | { readonly view: 'trash' };

/** Hash routing: the whole application is one document, and a book that is
    open is a location like any other, so the back button leaves it. */
export function parseHash(hash: string): Route {
  const raw = hash.replace(/^#\/?/, '');
  const [head = '', ...rest] = raw.split('/').map(decodeURIComponent);
  switch (head) {
    case 'book':
      return { view: 'book', id: Number(rest[0]) || 0 };
    case 'read':
      return { view: 'read', id: Number(rest[0]) || 0 };
    case 'reading':
      return { view: 'reading' };
    case 'folders':
      return { view: 'folders' };
    case 'formats':
      return { view: 'formats' };
    case 'trash':
      return { view: 'trash' };
    case 'format':
      return { view: 'shelf', format: rest[0] || undefined };
    case 'absent':
      return { view: 'shelf', only: 'absent' };
    case 'undated':
      return { view: 'shelf', only: 'undated' };
    case 'shelf':
      return { view: 'shelf', root: rest[0] || undefined, shelf: rest[1] || undefined };
    case 'folder':
      return {
        view: 'shelf',
        root: rest[0] || undefined,
        shelf: rest[1] || undefined,
        folder: rest[2] || undefined,
      };
    default:
      return { view: 'shelf' };
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}

export const go = (hash: string) => {
  location.hash = hash;
};

/** The key a view is identified by, so its scroll position can be restored. */
export function routeKey(route: Route): string {
  switch (route.view) {
    case 'shelf':
      return [
        'shelf',
        route.root ?? '',
        route.shelf ?? '',
        route.folder ?? '',
        route.format ?? '',
        route.only ?? '',
      ].join('|');
    case 'book':
    case 'read':
      return `${route.view}|${route.id}`;
    default:
      return route.view;
  }
}
