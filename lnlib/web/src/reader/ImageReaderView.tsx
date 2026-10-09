/* The reader for a pile of page images: a .cbz, or a folder of scans.

   These read right to left, so the left half of the page is *forward* and so is
   the ◀ button. Only a window of pages around the current one is ever in the
   document, and only the few just ahead are prefetched, because a volume of
   scans is two hundred images and several hundred megabytes. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { bookFile } from '../lib/mount';
import { useThrottle } from '../lib/hooks';
import { Delayed } from '../components/Delayed';
import { api } from '../lib/api';
import type { Book, Progress } from '../lib/types';

const AHEAD = 2; // pages prefetched in the reading direction
const BEHIND = 1; // and the other way, for turning back

interface ImageReaderViewProps {
  readonly book: Book;
  readonly pages: readonly string[];
  readonly direction: 'ltr' | 'rtl';
  readonly progress: Progress | null;
}

export default function ImageReaderView({
  book,
  pages,
  direction,
  progress,
}: ImageReaderViewProps) {
  const rtl = direction === 'rtl';
  const [index, setIndex] = useState(() => {
    const saved = Number(progress?.locator ?? 0);
    return Number.isFinite(saved) && saved >= 0 && saved < pages.length ? saved : 0;
  });
  const [loaded, setLoaded] = useState<ReadonlySet<number>>(() => new Set());
  const stageRef = useRef<HTMLDivElement | null>(null);

  /* Writing progress follows the reading rather than leading it: turning ten
     pages quickly is one write, not ten. The trailing edge is kept, so the
     page actually stopped on is the one recorded. */
  const [saveSoon, saveNow] = useThrottle((page: number) => {
    void api
      .saveProgress({
        book_id: book.id,
        locator: String(page),
        position: 0,
        percent: pages.length ? (page + 1) / pages.length : 0,
        finished: page >= pages.length - 1,
      })
      .catch(() => {
        /* reading must not stop because a write failed */
      });
  }, 2500);

  useEffect(() => {
    saveSoon(index);
  }, [index, saveSoon]);
  useEffect(() => () => saveNow(), [saveNow]);

  const step = useCallback(
    (delta: number) => {
      setIndex(current => Math.max(0, Math.min(pages.length - 1, current + delta)));
    },
    [pages.length],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          step(rtl ? -1 : 1);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          step(rtl ? 1 : -1);
          break;
        case 'ArrowDown':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          step(1);
          break;
        case 'ArrowUp':
        case 'PageUp':
          e.preventDefault();
          step(-1);
          break;
        case 'Home':
          setIndex(0);
          break;
        case 'End':
          setIndex(pages.length - 1);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, rtl, pages.length]);

  // The window of pages that exist as elements. Everything else is not in the
  // document at all, so the browser never decodes it.
  const window_ = useMemo(() => {
    const from = Math.max(0, index - BEHIND);
    const to = Math.min(pages.length - 1, index + AHEAD);
    const list: number[] = [];
    for (let i = from; i <= to; i++) list.push(i);
    return list;
  }, [index, pages.length]);

  const onLoad = useCallback((page: number) => {
    setLoaded(current => {
      if (current.has(page)) return current;
      const next = new Set(current);
      next.add(page);
      return next;
    });
  }, []);

  const turn = (e: React.MouseEvent<HTMLDivElement>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const left = e.clientX - stage.getBoundingClientRect().left < stage.clientWidth / 2;
    step(left === rtl ? 1 : -1);
  };

  const current = pages[index];

  return (
    <div className="imgreader">
      <div className="rstage" ref={stageRef} onClick={turn}>
        {window_.map(page => (
          <img
            key={page}
            className={`rpage${page === index ? ' on' : ''}`}
            src={bookFile(book.id, pages[page]!)}
            alt=""
            decoding="async"
            // The page being looked at is wanted now; the neighbours are only
            // there so the next turn is instant, and may wait their turn.
            fetchPriority={page === index ? 'high' : 'low'}
            onLoad={() => onLoad(page)}
          />
        ))}
        {!loaded.has(index) ? (
          <Delayed active after={200}>
            ページを読み込み中…
          </Delayed>
        ) : null}
      </div>

      <div className={`rfoot${rtl ? ' rtl' : ''}`}>
        <button className="sm" onClick={() => step(-1)} disabled={index === 0}>
          {rtl ? '▶' : '◀'}
        </button>
        <div className="rprog">
          <i style={{ width: `${(100 * (index + 1)) / pages.length}%` }} />
        </div>
        <span className="rpos">
          {index + 1} / {pages.length}
          {current ? ` · ${current.split('/').pop()}` : ''}
        </span>
        <button className="sm" onClick={() => step(1)} disabled={index >= pages.length - 1}>
          {rtl ? '◀' : '▶'}
        </button>
      </div>
    </div>
  );
}
