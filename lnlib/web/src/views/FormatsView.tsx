/* What the collection is made of.

   Now that a .txt is a text file rather than a volume that is missing, "how
   much of what do I have" is a real question with a real answer, and this is
   it: every format, how many books, how much disk, how many authors, and the
   span of release dates it covers. Each row is a link into the shelf filtered
   to that format. */

import { useEffect, useState } from 'react';
import { Delayed } from '../components/Delayed';
import { api, isAbort } from '../lib/api';
import { go } from '../lib/hooks';
import { bytes, formatLabel, READABLE } from '../lib/types';
import type { FormatDetail, ShelfFormat } from '../lib/types';

export function FormatsView() {
  const [data, setData] = useState<{
    formats: readonly FormatDetail[];
    by_shelf: readonly ShelfFormat[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .formats(undefined, undefined, controller.signal)
      .then(setData)
      .catch((e: unknown) => {
        if (!isAbort(e)) setError((e as Error).message);
      });
    return () => controller.abort();
  }, []);

  if (error) return <div className="err">{error}</div>;
  if (!data) return <Delayed active />;
  if (!data.formats.length) return <div className="empty">まだ何もありません</div>;

  const most = Math.max(...data.formats.map(f => f.n_books));

  // Shelf names contain spaces ("1. 連載中"), so the pair is carried as a pair
  // rather than flattened into a string and split back apart.
  const shelves: { root: string; shelf: string }[] = [];
  for (const row of data.by_shelf) {
    if (!shelves.some(s => s.root === row.root_label && s.shelf === row.shelf)) {
      shelves.push({ root: row.root_label, shelf: row.shelf });
    }
  }

  return (
    <>
      <div className="formatcards">
        {data.formats.map(f => (
          <button
            key={f.format}
            className="formatcard"
            onClick={() => go(`#/format/${encodeURIComponent(f.format)}`)}
          >
            <div className="fc-head">
              <span className="fc-name">{formatLabel(f.format)}</span>
              {READABLE.has(f.format) ? (
                <span className="chip ok">読める</span>
              ) : (
                <span className="chip">外部アプリ</span>
              )}
            </div>
            <div className="fc-count">{f.n_books.toLocaleString()}</div>
            <div className="fc-bar">
              <i style={{ width: `${(100 * f.n_books) / most}%` }} />
            </div>
            <dl className="fc-facts">
              <div>
                <dt>容量</dt>
                <dd>{bytes(f.bytes)}</dd>
              </div>
              <div>
                <dt>作者</dt>
                <dd>{f.n_authors}</dd>
              </div>
              <div>
                <dt>発売</dt>
                <dd>
                  {f.first_date
                    ? `${f.first_date.slice(0, 4)}–${(f.last_date || '').slice(0, 4)}`
                    : '—'}
                </dd>
              </div>
            </dl>
          </button>
        ))}
      </div>

      <h4 className="section">棚ごとの内訳</h4>
      <div className="tablewrap">
        <table className="vols">
          <thead>
            <tr>
              <th>棚</th>
              {data.formats.map(f => (
                <th key={f.format}>{formatLabel(f.format)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shelves.map(({ root, shelf }) => (
              <tr key={`${root}/${shelf}`}>
                <td className="name">
                  {root}
                  {shelf ? <span className="dim"> / {shelf}</span> : null}
                </td>
                {data.formats.map(f => {
                  const hit = data.by_shelf.find(
                    r => r.root_label === root && r.shelf === shelf && r.format === f.format,
                  );
                  return (
                    <td key={f.format} className="num">
                      {hit ? hit.n_books.toLocaleString() : <span className="dim">·</span>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
