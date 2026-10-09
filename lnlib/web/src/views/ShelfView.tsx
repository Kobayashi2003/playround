/* A shelf: a filter over the books table drawn as a virtual grid.

   Everything expensive is deferred. The search box waits for the typing to
   settle before it becomes a query; the grid asks for the pages it is about to
   draw and no others; the pages it has already seen are kept, so leaving a
   book and coming back is instant and lands where it left off.

   The format filter is offered from the counts the server sent back for this
   exact view, so a choice that would lead nowhere is never on screen.

   選択 turns the grid into a picker: a click ticks a card instead of opening
   it, Shift ticks a run of them, and すべて選択 means everything this view
   matches -- resolved on the server, since the browser never holds it all. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookGrid, type GridSelection } from '../components/BookGrid';
import { BatchDialog, type BatchKind } from '../components/BatchDialog';
import { Select } from '../components/Select';
import { Delayed } from '../components/Delayed';
import { api, invalidate } from '../lib/api';
import { forgetBook, forgetShelves, useShelf } from '../lib/shelf';
import { useSelection } from '../lib/selection';
import { go, useDebounced, type Route } from '../lib/hooks';
import { formatLabel } from '../lib/types';
import type { BookCard, ShelfQuery, SortOrder } from '../lib/types';

const ORDER_LABELS: Record<SortOrder, string> = {
  author: '作者順',
  date: '発売日（新しい順）',
  date_asc: '発売日（古い順）',
  title: 'タイトル順',
  added: '更新順',
  format: '形式順',
};

// Below this many removed books the grid drops them in place; above it the
// shelf reloads, which is cheaper than splicing thousands of rows one by one.
const SPLICE_LIMIT = 300;

interface ShelfViewProps {
  readonly route: Extract<Route, { view: 'shelf' }>;
  readonly scrollParent: HTMLElement | null;
  readonly search: string;
  readonly onChange: () => void;
}

export function ShelfView({ route, scrollParent, search, onChange }: ShelfViewProps) {
  const q = useDebounced(search.trim(), 240);
  const [order, setOrder] = useState<SortOrder>(() => {
    try {
      const saved = localStorage.getItem('lnlib.order');
      if (saved && saved in ORDER_LABELS) return saved as SortOrder;
    } catch {
      /* private mode */
    }
    return 'author';
  });
  // A format chosen here narrows whatever the route already is; a format that
  // *is* the route (#/format/epub) is fixed and not offered as a control.
  const [pick, setPick] = useState('');
  const fixedFormat = route.format ?? '';

  const query = useMemo<ShelfQuery>(
    () => ({
      root: route.root,
      shelf: route.shelf,
      folder: route.folder,
      only: route.only,
      format: fixedFormat || pick || undefined,
      q: q || undefined,
    }),
    [route.root, route.shelf, route.folder, route.only, fixedFormat, pick, q],
  );

  const shelf = useShelf(query, order);
  const { ensure, rememberScroll, facets, loadRange } = shelf;

  const [selecting, setSelecting] = useState(false);
  const picks = useSelection(Math.max(0, shelf.total));
  const [batch, setBatch] = useState<BatchKind | null>(null);

  // A new filter starts at the top, and a selection made under one filter
  // means nothing under another.
  const scrolled = useRef<string | null>(null);
  const key = `${q}|${order}|${pick}`;
  const { clear } = picks;
  useEffect(() => {
    if (scrolled.current === key) return;
    const first = scrolled.current === null;
    scrolled.current = key;
    clear();
    if (!first && scrollParent) scrollParent.scrollTop = 0;
  }, [key, scrollParent, clear]);

  const leaveSelecting = useCallback(() => {
    setSelecting(false);
    clear();
  }, [clear]);

  // Esc leaves selection mode; Ctrl+A selects everything in view. Neither
  // fires while typing, or while a batch dialog has the keyboard.
  useEffect(() => {
    if (!selecting || batch) return;
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement | null)?.closest('input, textarea, select');
      if (typing) return;
      // A book dialog can be open over a shelf that is still in selection mode
      // (a pasted link lands that way). Escape belongs to the dialog then, not
      // to the shelf behind it.
      if (location.hash.startsWith('#/book/')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        leaveSelecting();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        picks.selectAll();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting, batch, leaveSelecting, picks]);

  const onOpen = useCallback((book: BookCard) => {
    go(`#/book/${book.id}`);
  }, []);

  const gridSelection = useMemo<GridSelection | null>(() => {
    if (!selecting) return null;
    return {
      isPicked: picks.isPicked,
      toggle: (book, index, extend) => {
        if (!extend || picks.anchor === null) {
          picks.toggle(book.id, index);
          return;
        }
        // Shift: the whole run takes the state the clicked card is about to
        // take. Rows scrolled past too fast to load are fetched first.
        const on = !picks.isPicked(book.id);
        const from = Math.min(picks.anchor, index);
        const to = Math.max(picks.anchor, index);
        void loadRange(from, to).then(rows => {
          const ids: number[] = [];
          for (let i = from; i <= to; i++) {
            const row = rows[i];
            if (row) ids.push(row.id);
          }
          picks.setMany(ids, on);
          picks.setAnchor(index);
        });
      },
    };
  }, [selecting, picks, loadRange]);

  /** Carry out one batch action on whatever is ticked. */
  const runBatch = useCallback(
    async (kind: BatchKind, choice: 'keep' | 'trash') => {
      const action =
        kind === 'clear'
          ? ('clear_progress' as const)
          : choice === 'trash'
            ? ('trash' as const)
            : ('forget' as const);
      const body = picks.sel.all
        ? { action, query, exclude: [...picks.sel.ids], expect: picks.count }
        : { action, ids: [...picks.sel.ids], expect: picks.count };
      const result = await api.batchBooks(body);

      invalidate();
      if (action !== 'clear_progress' && !picks.sel.all && picks.sel.ids.size <= SPLICE_LIMIT) {
        for (const id of picks.sel.ids) forgetBook(id);
      } else {
        forgetShelves();
      }
      onChange();
      return result;
    },
    [picks, query, onChange],
  );

  const closeBatch = useCallback(
    (changed: boolean) => {
      setBatch(null);
      if (changed) clear();
    },
    [clear],
  );

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
          {shelf.total < 0 ? '' : `${shelf.total.toLocaleString()} 冊`}
          {q ? `　「${q}」` : ''}
        </span>

        <div className="controls">
          {!fixedFormat && choices.length > 1 ? (
            <div className="chipbar" role="group" aria-label="形式で絞り込む">
              <button className={`fchip${pick === '' ? ' on' : ''}`} onClick={() => setPick('')}>
                すべて
              </button>
              {choices.map(f => (
                <button
                  key={f.format}
                  className={`fchip${pick === f.format ? ' on' : ''}`}
                  onClick={() => setPick(pick === f.format ? '' : f.format)}
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
            onChange={next => {
              setOrder(next as SortOrder);
              try {
                localStorage.setItem('lnlib.order', next);
              } catch {
                /* private */
              }
              if (scrollParent) scrollParent.scrollTop = 0;
            }}
          >
            {Object.entries(ORDER_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Select>

          <button
            className={`sm selbtn${selecting ? ' on' : ''}`}
            onClick={() => (selecting ? leaveSelecting() : setSelecting(true))}
            disabled={shelf.total <= 0}
            title="まとめて選んで操作する（Esc で終了）"
          >
            {selecting ? '選択を終了' : '選択'}
          </button>
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
          selection={gridSelection}
        />
      )}

      {selecting ? (
        <div className="selbar" role="toolbar" aria-label="選択した本の操作">
          <span className="sel-count">
            <b>{picks.count.toLocaleString()}</b> 冊選択
            {picks.sel.all ? <em>（この一覧のすべて）</em> : null}
          </span>
          <button
            className="sm"
            onClick={picks.selectAll}
            disabled={picks.sel.all && picks.sel.ids.size === 0}
          >
            すべて選択（{Math.max(0, shelf.total).toLocaleString()}）
          </button>
          <button className="sm" onClick={clear} disabled={picks.count === 0}>
            選択解除
          </button>
          <span className="grow" />
          <button className="sm" onClick={() => setBatch('clear')} disabled={picks.count === 0}>
            読書記録を消す
          </button>
          <button
            className="sm danger"
            onClick={() => setBatch('remove')}
            disabled={picks.count === 0}
          >
            棚から外す
          </button>
        </div>
      ) : null}

      {batch ? (
        <BatchDialog
          kind={batch}
          count={picks.count}
          run={choice => runBatch(batch, choice)}
          onClose={closeBatch}
        />
      ) : null}
    </>
  );
}
