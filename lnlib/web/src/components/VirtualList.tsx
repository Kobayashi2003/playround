/* A list that only renders the rows on screen.

   The shelf grid does this for covers; this is the same idea for plain rows,
   where every row is the same height and the arithmetic is one division. The
   box reserves the full height so the scrollbar is honest, and only the rows
   crossing the viewport (plus a few either side) exist as elements. */

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useRafThrottle } from "../lib/hooks";

interface VirtualListProps<T> {
  readonly items: readonly T[];
  readonly rowHeight: number;
  /** The element that actually scrolls; the list measures itself against it. */
  readonly scrollParent: HTMLElement | null;
  readonly render: (item: T, index: number) => ReactNode;
  readonly rowKey: (item: T, index: number) => string | number;
  readonly overscan?: number;
}

export function VirtualList<T>({
  items, rowHeight, scrollParent, render, rowKey, overscan = 8,
}: VirtualListProps<T>) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [range, setRange] = useState({ first: 0, last: 40 });

  const measure = useRafThrottle(() => {
    const scroller = scrollParent;
    const box = boxRef.current;
    if (!scroller || !box) return;
    const top = scroller.scrollTop - box.offsetTop;
    const first = Math.max(0, Math.floor(top / rowHeight) - overscan);
    const last = Math.min(items.length - 1,
      Math.ceil((top + scroller.clientHeight) / rowHeight) + overscan);
    setRange((current) =>
      current.first === first && current.last === last ? current : { first, last });
  });

  useLayoutEffect(() => { measure(); }, [measure, items.length, rowHeight]);

  useEffect(() => {
    if (!scrollParent) return;
    const scroller = scrollParent;
    scroller.addEventListener("scroll", measure, { passive: true });
    const observer = new ResizeObserver(() => measure());
    observer.observe(scroller);
    return () => {
      scroller.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [scrollParent, measure]);

  const rows = [];
  for (let i = range.first; i <= range.last && i < items.length; i++) {
    const item = items[i]!;
    rows.push(
      <div
        key={rowKey(item, i)}
        className="vrow"
        style={{ transform: `translateY(${i * rowHeight}px)`, height: rowHeight }}
      >
        {render(item, i)}
      </div>,
    );
  }

  return (
    <div className="vlist" ref={boxRef} style={{ height: items.length * rowHeight }}>
      {rows}
    </div>
  );
}
