/* The shelf grid, virtualised.

   Four thousand volumes is not a lot of data, but every tile owns a cover, and
   the covers are full-size images pulled out of the books. Rendering them all
   meant hundreds of megabytes of decoded bitmap and a scroll that stopped dead
   every few rows. So only the rows crossing the viewport exist as elements;
   the rest is empty space of exactly the right height, which is what keeps the
   scrollbar telling the truth.

   Cell geometry is computed rather than left to `auto-fill`, because virtual
   scrolling has to know where row N is before row N is rendered. The CSS still
   describes the look; this only decides positions. */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Cover } from "./Cover";
import { useElementWidth, useRafThrottle } from "../lib/hooks";
import * as Thumbs from "../lib/thumbs";
import type { BookCard } from "../lib/types";

const CELL = { min: 132, gapX: 14, gapY: 16, caption: 56, overscan: 2 };

interface BookGridProps {
  readonly rows: readonly (BookCard | undefined)[];
  readonly total: number;
  /** The element that actually scrolls; the grid measures itself against it. */
  readonly scrollParent: HTMLElement | null;
  readonly onRange: (from: number, to: number) => void;
  readonly onOpen: (book: BookCard) => void;
  /** Restored once on mount, then written back as the reader scrolls. */
  readonly initialScroll?: number;
  readonly onScroll?: (top: number) => void;
}

export function BookGrid({
  rows, total, scrollParent, onRange, onOpen, initialScroll = 0, onScroll,
}: BookGridProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const width = useElementWidth(scrollParent);
  const [range, setRange] = useState({ first: 0, last: -1 });

  const geometry = useMemo(() => {
    const usable = Math.max(width, CELL.min);
    const cols = Math.max(1, Math.floor((usable + CELL.gapX) / (CELL.min + CELL.gapX)));
    const cellW = Math.floor((usable - CELL.gapX * (cols - 1)) / cols);
    const cellH = Math.round(cellW * 7 / 5) + 6 + CELL.caption;  // .thumb is 5:7
    return { cols, cellW, cellH };
  }, [width]);

  const lines = total > 0 ? Math.ceil(total / geometry.cols) : 0;
  const height = lines * geometry.cellH + Math.max(0, lines - 1) * CELL.gapY;

  /* Which rows are on screen. Recomputed on scroll -- coalesced to one frame,
     because scroll events arrive several times per frame on a trackpad.

     This works out the range and nothing else. Reporting the offset back is
     deliberately not part of it: `measure` also runs from a layout effect on
     mount, and reporting an offset of 0 from there would overwrite the very
     position the grid is about to restore. */
  const measure = useRafThrottle(() => {
    const scroller = scrollParent;
    const box = boxRef.current;
    if (!scroller || !box || total <= 0) return;
    const top = scroller.scrollTop - box.offsetTop;
    const rowH = geometry.cellH + CELL.gapY;
    const firstLine = Math.max(0, Math.floor(top / rowH) - CELL.overscan);
    const lastLine = Math.floor((top + scroller.clientHeight) / rowH) + CELL.overscan;
    const first = Math.max(0, firstLine * geometry.cols);
    const last = Math.min(total - 1, (lastLine + 1) * geometry.cols - 1);
    setRange((current) =>
      current.first === first && current.last === last ? current : { first, last });
  });

  useLayoutEffect(() => { measure(); }, [measure, geometry, total, width]);

  // Only a real scroll writes the offset down, and only after the saved one
  // has been put back, so returning to a shelf twice lands in the same place.
  const restored = useRef(false);
  const onUserScroll = useRafThrottle(() => {
    measure();
    if (restored.current && scrollParent) onScroll?.(scrollParent.scrollTop);
  });

  useEffect(() => {
    if (!scrollParent) return;
    const scroller = scrollParent;
    scroller.addEventListener("scroll", onUserScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onUserScroll);
  }, [scrollParent, onUserScroll]);

  // Restoring the scroll offset waits for the box to have its full height,
  // otherwise the browser clamps it back to whatever fits and the shelf jumps
  // to the top on the way back from a book. A grid with nothing to restore is
  // "restored" immediately, so its scrolling starts being recorded at once.
  useLayoutEffect(() => {
    const scroller = scrollParent;
    if (restored.current || !scroller) return;
    if (!initialScroll) { restored.current = true; return; }
    if (!height || height < initialScroll) return;
    restored.current = true;
    scroller.scrollTop = initialScroll;
    measure();
  }, [scrollParent, initialScroll, height, measure]);

  useEffect(() => {
    if (range.last >= range.first) onRange(range.first, range.last);
  }, [range, onRange]);

  // Covers for what is on screen jump the queue ahead of ones left behind.
  useEffect(() => {
    if (!Thumbs.supported()) return;
    const hot = new Set<number>();
    for (let i = range.first; i <= range.last; i++) {
      const row = rows[i];
      if (row && row.cover_state !== "none" && row.cover_state !== "error") {
        hot.add(row.id);
      }
    }
    Thumbs.prioritise(hot);
  }, [range, rows]);

  const cards = [];
  for (let i = range.first; i <= range.last && i < total; i++) {
    const row = rows[i];
    const x = (i % geometry.cols) * (geometry.cellW + CELL.gapX);
    const y = Math.floor(i / geometry.cols) * (geometry.cellH + CELL.gapY);
    cards.push(
      <div
        key={i}
        className={`card vcard${row ? "" : " skel"}`}
        style={{ transform: `translate(${x}px, ${y}px)`, width: geometry.cellW }}
        onClick={row ? () => onOpen(row) : undefined}
        role={row ? "button" : undefined}
        tabIndex={row ? 0 : undefined}
        onKeyDown={row ? (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(row); }
        } : undefined}
      >
        {row ? <BookCardBody book={row} /> : <div className="thumb" />}
      </div>,
    );
  }

  return <div className="vgrid" ref={boxRef} style={{ height }}>{cards}</div>;
}

function BookCardBody({ book }: { readonly book: BookCard }) {
  const percent = Math.round((book.read_percent || 0) * 100);
  // A book the last scan could not find still shows everything it knew; the
  // badge says so rather than the card pretending it is not there.
  const absent = !book.present;
  const badge = absent
    ? "不明"
    : book.read_finished
      ? "読了"
      : percent > 0 ? `${percent}%` : "";
  return (
    <>
      <div className={`thumb${absent ? " absent" : ""}`}>
        <Cover bookId={book.id} state={book.cover_state} alt="" />
        {badge ? (
          <span className={`badge${absent ? " miss" : ""}`}>{badge}</span>
        ) : null}
      </div>
      <div className="cap">
        <div className="t">{book.title}</div>
        <div className="a">
          {book.author || "作者不明"}
          {book.date ? ` · ${book.date.slice(0, 7)}` : ""}
        </div>
      </div>
    </>
  );
}
