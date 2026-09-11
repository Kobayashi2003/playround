/* The reader for a plain text book.

   A .txt is a book like any other now, and some of them run to a megabyte of
   Japanese, which is far too much to hand the browser as one block and ask it
   to lay out. So the text is split into lines once and the lines are windowed
   the same way the shelf's grid is: only what is on screen exists as an
   element, and the scrollbar is still the right length because the lines that
   are not rendered are measured and their space reserved.

   Japanese prose is set vertically, and a `writing-mode: vertical-rl` block
   grows sideways and scrolls sideways. So the window works along whichever
   axis the current mode actually uses -- offsets are line *extents*, not
   heights, and the same arithmetic serves both. */

import {
  useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
} from "react";
import { api } from "../lib/api";
import { useRafThrottle, useThrottle } from "../lib/hooks";
import type { Book, Progress } from "../lib/types";

const OVERSCAN = 8;
const ESTIMATE = 30;          // px per line before one has been measured

interface TextReaderViewProps {
  readonly book: Book;
  readonly text: string;
  readonly encoding: string;
  readonly progress: Progress | null;
}

export default function TextReaderView({
  book, text, encoding, progress,
}: TextReaderViewProps) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(() => {
    const saved = Number(localStorage.getItem("lnlib.textsize") || 0);
    return saved >= 12 && saved <= 32 ? saved : 17;
  });
  const [vertical, setVertical] = useState(
    () => localStorage.getItem("lnlib.textvertical") === "1",
  );

  const lines = useMemo(() => text.split(/\r?\n/), [text]);

  const extents = useRef<number[]>([]);
  const [generation, bump] = useState(0);
  const [range, setRange] = useState({ first: 0, last: 80 });

  // A change of axis or text size invalidates every measurement at once.
  const shape = `${vertical}|${size}|${lines.length}`;
  const lastShape = useRef(shape);
  if (lastShape.current !== shape || extents.current.length !== lines.length) {
    lastShape.current = shape;
    extents.current = new Array(lines.length).fill(ESTIMATE);
  }

  const offsets = useMemo(() => {
    const out = new Array(lines.length + 1).fill(0);
    for (let i = 0; i < lines.length; i++) {
      out[i + 1] = out[i] + (extents.current[i] ?? ESTIMATE);
    }
    return out;
    // `generation` is what re-runs this after a measured extent changes.
  }, [lines.length, generation, shape]);

  const total = offsets[lines.length] ?? 0;

  /** How far along the reading is, and how much of the axis is visible. */
  const geometry = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    // vertical-rl grows to the left, so scrollLeft counts down from 0.
    const along = vertical ? Math.abs(el.scrollLeft) : el.scrollTop;
    const visible = vertical ? el.clientWidth : el.clientHeight;
    return { el, along, visible };
  }, [vertical]);

  const [saveSoon, saveNow] = useThrottle((fraction: number) => {
    void api.saveProgress({
      book_id: book.id,
      locator: fraction.toFixed(5),
      position: fraction,
      percent: fraction,
      finished: fraction >= 0.995,
    }).catch(() => { /* reading must not stop because a write failed */ });
  }, 3000);

  const measure = useRafThrottle(() => {
    const box = geometry();
    if (!box) return;
    const { along, visible } = box;
    let first = 0;
    while (first < lines.length && offsets[first + 1] < along) first++;
    let last = first;
    while (last < lines.length - 1 && offsets[last] < along + visible) last++;
    setRange((current) => {
      const f = Math.max(0, first - OVERSCAN);
      const l = Math.min(lines.length - 1, last + OVERSCAN);
      return current.first === f && current.last === l ? current : { first: f, last: l };
    });
    if (total > visible) saveSoon(Math.min(1, along / (total - visible)));
  });

  useEffect(() => () => saveNow(), [saveNow]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    return () => el.removeEventListener("scroll", measure);
  }, [measure]);

  useLayoutEffect(() => { measure(); }, [measure, shape]);

  // Where it was left off, once there is a length to be a fraction of.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const box = geometry();
    if (restored.current || !box || !total) return;
    restored.current = true;
    const at = Number(progress?.position ?? 0);
    if (at > 0) {
      const along = at * Math.max(0, total - box.visible);
      if (vertical) box.el.scrollLeft = -along;
      else box.el.scrollTop = along;
    }
    measure();
  }, [total, progress, measure, geometry, vertical]);

  /** A line that has just been laid out reports its real extent once. */
  const report = useCallback((index: number, extent: number) => {
    if (Math.abs((extents.current[index] ?? 0) - extent) < 0.5) return;
    extents.current[index] = extent;
    bump((n) => n + 1);
  }, []);

  const shown = [];
  for (let i = range.first; i <= range.last && i < lines.length; i++) {
    shown.push(
      <Line key={i} index={i} text={lines[i]!} vertical={vertical}
            onMeasure={report} />,
    );
  }

  const step = (delta: number) => {
    const next = Math.max(12, Math.min(32, size + delta));
    setSize(next);
    try { localStorage.setItem("lnlib.textsize", String(next)); } catch { /* ignore */ }
  };

  const start = offsets[range.first] ?? 0;

  return (
    <div className="textreader">
      <div className="tbar">
        <span className="dim">{encoding} · {lines.length.toLocaleString()} 行</span>
        <span className="spacer" />
        <button className="sm" onClick={() => step(-1)} title="文字を小さく">A−</button>
        <button className="sm" onClick={() => step(1)} title="文字を大きく">A＋</button>
        <button
          className={`sm${vertical ? " on" : ""}`}
          onClick={() => {
            const next = !vertical;
            restored.current = true;      // do not jump back on the axis swap
            setVertical(next);
            try {
              localStorage.setItem("lnlib.textvertical", next ? "1" : "0");
            } catch { /* ignore */ }
          }}
          title="縦書きと横書きを切り替える"
        >
          {vertical ? "横書きに" : "縦書きに"}
        </button>
      </div>

      <div
        className={`tscroll${vertical ? " vertical" : ""}`}
        ref={scrollRef}
        style={{ fontSize: size }}
        tabIndex={0}
      >
        <div
          className="tspacer"
          style={vertical ? { width: total } : { height: total }}
        >
          <div
            className="tlines"
            style={{
              transform: vertical
                ? `translateX(${-start}px)` : `translateY(${start}px)`,
            }}
          >
            {shown}
          </div>
        </div>
      </div>
    </div>
  );
}

function Line({ index, text, vertical, onMeasure }: {
  readonly index: number;
  readonly text: string;
  readonly vertical: boolean;
  readonly onMeasure: (index: number, extent: number) => void;
}) {
  const ref = useRef<HTMLParagraphElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) onMeasure(index, vertical ? el.offsetWidth : el.offsetHeight);
  });
  return (
    <p ref={ref} className={text.trim() ? "tline" : "tline tblank"}>
      {text || " "}
    </p>
  );
}
