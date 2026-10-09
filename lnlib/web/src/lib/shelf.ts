/* The rows behind the grid, fetched a page at a time and kept between visits.

   The shelf is a window onto a table with thousands of rows in it, so it is
   never held whole. What it does hold is the pages it has actually looked at:
   walking into a book and coming straight back out lands on the same rows, at
   the same scroll offset, without asking the server anything.

   A store is identified by the query that produced it. Change the shelf, the
   search, the format filter or the sort and it is a different store, so nothing
   has to be invalidated by hand; the last few are kept and the rest are
   dropped. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, isAbort } from './api';
import type { BookCard, Facet, ShelfQuery, SortOrder } from './types';

export const PAGE = 120;
const MAX_STORES = 6; // how many query results stay warm at once

interface Store {
  query: ShelfQuery;
  rows: (BookCard | undefined)[];
  total: number;
  facets: readonly Facet[];
  loaded: Set<number>; // page numbers already in `rows`
  inflight: Map<number, Promise<void>>;
  scrollTop: number;
  error: string | null;
  listeners: Set<() => void>;
  version: number;
  /** Bumped whenever the rows move under the pages already asked for. */
  epoch: number;
}

const stores = new Map<string, Store>();

const keyOf = (query: ShelfQuery) =>
  [
    query.root ?? '',
    query.shelf ?? '',
    query.folder ?? '',
    query.only ?? '',
    query.format ?? '',
    query.order ?? '',
    query.q ?? '',
  ].join(' ');

function storeFor(query: ShelfQuery): Store {
  const key = keyOf(query);
  const existing = stores.get(key);
  if (existing) {
    // Re-inserting keeps the map in least-recently-used order.
    stores.delete(key);
    stores.set(key, existing);
    return existing;
  }
  const fresh: Store = {
    query,
    rows: [],
    total: -1,
    facets: [],
    loaded: new Set(),
    inflight: new Map(),
    scrollTop: 0,
    error: null,
    listeners: new Set(),
    version: 0,
    epoch: 0,
  };
  stores.set(key, fresh);
  while (stores.size > MAX_STORES) {
    const oldest = stores.keys().next().value;
    if (oldest === undefined || oldest === key) break;
    const dropped = stores.get(oldest);
    if (dropped && dropped.listeners.size) break; // still on screen: keep it
    stores.delete(oldest);
  }
  return fresh;
}

/** Everything remembered, thrown away. Called after a scan changes the index.

    A store still on screen is emptied in place rather than dropped: the grid
    holding it only asks for its first page when the store changes, and the
    query -- so the store -- has not. It has to be refilled from here, or the
    view sits on its loading line until the page is reloaded. */
export function forgetShelves(): void {
  for (const [key, store] of [...stores]) {
    store.rows = [];
    store.total = -1;
    store.facets = [];
    store.error = null;
    store.loaded.clear();
    store.inflight.clear();
    store.epoch += 1;
    if (store.listeners.size) {
      void loadPage(store, 0);
      announce(store);
    } else {
      stores.delete(key);
    }
  }
}

/** One book is gone from the index; drop it from every view holding it.

    Cheaper and much less jarring than reloading: deleting a book from the
    shelf should not scroll it back to the top of a thousand rows. */
export function forgetBook(bookId: number): void {
  for (const store of stores.values()) {
    const at = store.rows.findIndex(row => row?.id === bookId);
    if (at < 0) continue;
    store.rows.splice(at, 1);
    if (store.total > 0) store.total -= 1;
    // The rows after it have all shifted by one, so the pages they were
    // fetched as no longer line up. Only the tail has to be re-fetched --
    // and a page still in flight is now answering a question about where the
    // rows used to be, so its answer is dropped rather than filed one out.
    store.epoch += 1;
    store.inflight.clear();
    for (const page of [...store.loaded]) {
      if ((page + 1) * PAGE > at) store.loaded.delete(page);
    }
    announce(store);
  }
}

function announce(store: Store): void {
  store.version += 1;
  for (const listener of store.listeners) listener();
}

function loadPage(store: Store, page: number): Promise<void> {
  if (store.loaded.has(page)) return Promise.resolve();
  const running = store.inflight.get(page);
  if (running) return running;

  // What the rows meant when this was asked for; see `forgetBook`.
  const asked = store.epoch;
  const request: Promise<void> = api
    .books(store.query, page * PAGE, PAGE)
    .then(data => {
      if (store.inflight.get(page) === request) store.inflight.delete(page);
      if (store.epoch !== asked) return;
      store.loaded.add(page);
      store.error = null;
      if (page === 0) store.facets = data.facets;
      if (store.total !== data.total) {
        store.total = data.total;
        if (store.rows.length > data.total) store.rows.length = data.total;
      }
      data.books.forEach((row, index) => {
        store.rows[page * PAGE + index] = row;
      });
      announce(store);
    })
    .catch((error: unknown) => {
      if (store.inflight.get(page) === request) store.inflight.delete(page);
      if (store.epoch !== asked || isAbort(error)) return;
      store.error = (error as Error).message || String(error);
      announce(store);
    });

  store.inflight.set(page, request);
  return request;
}

export interface ShelfHandle {
  readonly rows: readonly (BookCard | undefined)[];
  readonly total: number;
  /** What the format filter could still narrow this view to. */
  readonly facets: readonly Facet[];
  readonly error: string | null;
  /** True until the first page has landed, which is the only blocking wait. */
  readonly loading: boolean;
  /** Ask for every page covering this row range; already-held pages are free. */
  ensure(from: number, to: number): void;
  /** The same, but waits: resolves once every row in the range is held. A
      Shift-selection across a stretch scrolled past too quickly to load has to
      know what is in it before it can pick it. */
  loadRange(from: number, to: number): Promise<readonly (BookCard | undefined)[]>;
  readonly scrollTop: number;
  rememberScroll(top: number): void;
}

export function useShelf(query: ShelfQuery, order: SortOrder): ShelfHandle {
  const full = useMemo<ShelfQuery>(() => ({ ...query, order }), [query, order]);
  const store = useMemo(() => storeFor(full), [full]);
  const [, bump] = useState(0);

  useEffect(() => {
    const listener = () => bump(n => n + 1);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, [store]);

  // The first page is always wanted; without it the grid has no height and so
  // never works out which rows are on screen.
  useEffect(() => {
    void loadPage(store, 0);
  }, [store]);

  const ensure = useCallback(
    (from: number, to: number) => {
      const last = store.total >= 0 ? Math.min(to, store.total - 1) : to;
      for (
        let page = Math.floor(Math.max(0, from) / PAGE);
        page <= Math.floor(Math.max(0, last) / PAGE);
        page++
      ) {
        void loadPage(store, page);
      }
    },
    [store],
  );

  const loadRange = useCallback(
    async (from: number, to: number) => {
      const last = store.total >= 0 ? Math.min(to, store.total - 1) : to;
      const waits: Promise<void>[] = [];
      for (
        let page = Math.floor(Math.max(0, from) / PAGE);
        page <= Math.floor(Math.max(0, last) / PAGE);
        page++
      ) {
        waits.push(loadPage(store, page));
      }
      await Promise.all(waits);
      return store.rows;
    },
    [store],
  );

  const rememberScroll = useCallback(
    (top: number) => {
      store.scrollTop = top;
    },
    [store],
  );

  return {
    rows: store.rows,
    total: store.total,
    facets: store.facets,
    error: store.error,
    loading: store.total < 0 && !store.error,
    ensure,
    loadRange,
    scrollTop: store.scrollTop,
    rememberScroll,
  };
}
