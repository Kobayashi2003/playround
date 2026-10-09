/* Which books are ticked.

   A selection is one of two things, and the difference matters on a shelf of
   tens of thousands:

     picked   these ids, and nothing else
     all      everything the current view matches, *except* these ids

   "Select all" is the second kind. It is never turned into a list of ids in
   the browser -- the browser only holds the pages it has scrolled past -- so
   the server resolves it from the same filter the view is showing. Unticking a
   card after "select all" adds it to the exceptions rather than building a
   list of the other twenty-nine thousand. */

import { useCallback, useMemo, useState } from 'react';

export interface Selection {
  readonly all: boolean;
  /** Picked ids when `all` is false; the exceptions when it is true. */
  readonly ids: ReadonlySet<number>;
}

const EMPTY: Selection = { all: false, ids: new Set() };

export function useSelection(total: number) {
  const [sel, setSel] = useState<Selection>(EMPTY);
  const [anchor, setAnchor] = useState<number | null>(null);

  const isPicked = useCallback(
    (id: number) => (sel.all ? !sel.ids.has(id) : sel.ids.has(id)),
    [sel],
  );

  const count = sel.all ? Math.max(0, total - sel.ids.size) : sel.ids.size;

  /** Tick or untick several at once, whichever kind of selection this is. */
  const setMany = useCallback((ids: readonly number[], on: boolean) => {
    setSel(current => {
      const next = new Set(current.ids);
      // In "picked" mode the set holds what is ticked; in "all" mode it holds
      // what is not. Ticking means adding to the first and removing from the
      // second.
      const add = current.all ? !on : on;
      for (const id of ids) {
        if (add) next.add(id);
        else next.delete(id);
      }
      return { all: current.all, ids: next };
    });
  }, []);

  const toggle = useCallback(
    (id: number, index: number) => {
      setMany([id], !isPicked(id));
      setAnchor(index);
    },
    [isPicked, setMany],
  );

  const selectAll = useCallback(() => {
    setSel({ all: true, ids: new Set() });
    setAnchor(null);
  }, []);

  const clear = useCallback(() => {
    setSel(EMPTY);
    setAnchor(null);
  }, []);

  return useMemo(
    () => ({
      sel,
      count,
      anchor,
      isPicked,
      setMany,
      toggle,
      selectAll,
      clear,
      setAnchor,
    }),
    [sel, count, anchor, isPicked, setMany, toggle, selectAll, clear],
  );
}

export type SelectionHandle = ReturnType<typeof useSelection>;
