/* What is open at the moment: everything with saved progress, newest first. */

import { useEffect, useState } from "react";
import { Cover } from "../components/Cover";
import { Delayed } from "../components/Delayed";
import { api, isAbort } from "../lib/api";
import { go } from "../lib/hooks";
import type { ReadingRow } from "../lib/types";

export function ReadingView({ onCount }: { readonly onCount: (n: number) => void }) {
  const [rows, setRows] = useState<readonly ReadingRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api.reading(120, controller.signal)
      .then((data) => {
        setRows(data.books);
        onCount(data.books.filter((row) => !row.finished).length);
      })
      .catch((e: unknown) => { if (!isAbort(e)) setError((e as Error).message); });
    return () => controller.abort();
  }, [onCount]);

  if (error) return <div className="err">{error}</div>;
  if (!rows) return <Delayed active />;
  if (!rows.length) {
    return <div className="empty">まだ読みかけの本はありません</div>;
  }

  return (
    <div className="grid">
      {rows.map((row) => {
        const percent = Math.round((row.percent || 0) * 100);
        return (
          <div key={row.id} className="card" onClick={() => go(`#/read/${row.id}`)}>
            <div className="thumb">
              <Cover bookId={row.id} state={row.cover_state} alt="" />
              <span className={`badge${row.finished ? " ok" : ""}`}>
                {row.finished ? "読了" : `${percent}%`}
              </span>
            </div>
            <div className="cap">
              <div className="t">{row.title}</div>
              <div className="a">{row.author || "作者不明"}</div>
              <div className="bar">
                <i style={{ width: `${row.finished ? 100 : percent}%` }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
