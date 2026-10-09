/* What is open at the moment: everything with saved progress, newest first. */

import { useEffect, useState } from 'react';
import { Cover } from '../components/Cover';
import { Delayed } from '../components/Delayed';
import { api, isAbort } from '../lib/api';
import { go } from '../lib/hooks';
import type { ReadingRow } from '../lib/types';

export function ReadingView({ onCount }: { readonly onCount: (n: number) => void }) {
  const [rows, setRows] = useState<readonly ReadingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .reading(120, controller.signal)
      .then(data => {
        setRows(data.books);
        onCount(data.books.filter(row => !row.finished).length);
      })
      .catch((e: unknown) => {
        if (!isAbort(e)) setError((e as Error).message);
      });
    return () => controller.abort();
  }, [onCount]);

  if (error) return <div className="err">{error}</div>;
  if (!rows) return <Delayed active />;
  if (!rows.length) {
    return <div className="empty">まだ読みかけの本はありません</div>;
  }

  return (
    <div className="grid">
      {rows.map(row => {
        const percent = Math.round((row.percent || 0) * 100);
        return (
          <div key={row.id} className="card" onClick={() => go(`#/read/${row.id}`)}>
            <div className="thumb">
              <Cover bookId={row.id} state={row.cover_state} alt="" />
              {row.finished ? <span className="badge ok">読了</span> : null}
              {!row.finished ? (
                <span className="progress" title={`${percent}%`}>
                  <i style={{ width: `${percent}%` }} />
                </span>
              ) : null}
            </div>
            <div className="cap">
              <div className="t">{row.title}</div>
              <div className="a">{row.author || '作者不明'}</div>
              {/* This is the view about how far in you are, so here the number
                  is worth a line of its own. */}
              <div className="pct">{row.finished ? '読了' : `${percent}%`}</div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
