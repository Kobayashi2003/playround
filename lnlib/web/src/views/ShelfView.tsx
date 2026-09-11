/* A shelf: a filter over the books table drawn as a virtual grid.

   Everything expensive is deferred. The search box waits for the typing to
   settle before it becomes a query; the grid asks for the pages it is about to
   draw and no others; the pages it has already seen are kept, so leaving a
   book and coming back is instant and lands where it left off.

   The format filter is offered from the counts the server sent back for this
   exact view, so a choice that would lead nowhere is never on screen. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BookGrid } from "../components/BookGrid";
import { Select } from "../components/Select";
import { Delayed } from "../components/Delayed";
import { useShelf } from "../lib/shelf";
import { go, useDebounced, type Route } from "../lib/hooks";
import { formatLabel } from "../lib/types";
import type { BookCard, ShelfQuery, SortOrder } from "../lib/types";

const ORDER_LABELS: Record<SortOrder, string> = {
  author: "作者順",
  date: "発売日（新しい順）",
  date_asc: "発売日（古い順）",
  title: "タイトル順",
  added: "更新順",
  format: "形式順",
};

interface ShelfViewProps {
  readonly route: Extract<Route, { view: "shelf" }>;
  readonly scrollParent: HTMLElement | null;
  readonly search: string;
}

export function ShelfView({ route, scrollParent, search }: ShelfViewProps) {
  const q = useDebounced(search.trim(), 240);
  const [order, setOrder] = useState<SortOrder>(() => {
    try {
      const saved = localStorage.getItem("lnlib.order");
      if (saved && saved in ORDER_LABELS) return saved as SortOrder;
    } catch { /* private mode */ }
    return "author";
  });
  // A format chosen here narrows whatever the route already is; a format that
  // *is* the route (#/format/epub) is fixed and not offered as a control.
  const [pick, setPick] = useState("");
  const fixedFormat = route.format ?? "";

  const query = useMemo<ShelfQuery>(() => ({
    root: route.root, shelf: route.shelf, folder: route.folder,
    only: route.only, format: fixedFormat || pick || undefined,
    q: q || undefined,
  }), [route.root, route.shelf, route.folder, route.only, fixedFormat, pick, q]);

  const shelf = useShelf(query, order);
  const { ensure, rememberScroll, facets } = shelf;

  // A new filter starts at the top; a shelf that has been visited before keeps
  // the offset it was left at, which `useShelf` has held on to.
  const scrolled = useRef<string | null>(null);
  const key = `${q}|${order}|${pick}`;
  useEffect(() => {
    if (scrolled.current === key) return;
    const first = scrolled.current === null;
    scrolled.current = key;
    if (!first && scrollParent) scrollParent.scrollTop = 0;
  }, [key, scrollParent]);

  const onOpen = useCallback((book: BookCard) => { go(`#/book/${book.id}`); }, []);

  // The facet list is only meaningful while nothing has been picked; once one
  // is, the server stops counting the others, so the last full list is kept.
  const offered = useRef<readonly { format: string; n: number }[]>([]);
  if (!pick && facets.length) offered.current = facets;
  const choices = pick ? offered.current : facets;

  if (shelf.error) return <div className="err">{shelf.error}</div>;

  return (
    <>
      <div className="shelfbar">
        <span className="sub">
          {shelf.total < 0 ? "" : `${shelf.total.toLocaleString()} 冊`}
          {q ? `　「${q}」` : ""}
        </span>

        <div className="controls">
          {!fixedFormat && choices.length > 1 ? (
            <div className="chipbar" role="group" aria-label="形式で絞り込む">
              <button
                className={`fchip${pick === "" ? " on" : ""}`}
                onClick={() => setPick("")}
              >
                すべて
              </button>
              {choices.map((f) => (
                <button
                  key={f.format}
                  className={`fchip${pick === f.format ? " on" : ""}`}
                  onClick={() => setPick(pick === f.format ? "" : f.format)}
                >
                  {formatLabel(f.format)}
                  <span className="n">{f.n}</span>
                </button>
              ))}
            </div>
          ) : null}

          <Select
            className="order"
            value={order}
            label="並び順"
            onChange={(next) => {
              setOrder(next as SortOrder);
              try { localStorage.setItem("lnlib.order", next); } catch { /* private */ }
              if (scrollParent) scrollParent.scrollTop = 0;
            }}
          >
            {Object.entries(ORDER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </Select>
        </div>
      </div>

      {shelf.loading ? (
        <Delayed active />
      ) : shelf.total === 0 ? (
        <div className="empty">該当する本がありません</div>
      ) : (
        <BookGrid
          rows={shelf.rows}
          total={shelf.total}
          scrollParent={scrollParent}
          onRange={ensure}
          onOpen={onOpen}
          initialScroll={shelf.scrollTop}
          onScroll={rememberScroll}
        />
      )}
    </>
  );
}
