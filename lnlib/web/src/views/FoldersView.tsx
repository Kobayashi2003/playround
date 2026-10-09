/* The content folders on disk.

   This is the closest thing left to a series list, and it is deliberately only
   what the filesystem says: a folder someone made, and how many books are in
   it. Nothing here is inferred from titles.

   A Calibre-style root has a folder per author, so this can run to many
   thousands of rows; it is a virtual list for the same reason the shelf is a
   virtual grid. */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Delayed } from '../components/Delayed';
import { VirtualList } from '../components/VirtualList';
import { api, isAbort } from '../lib/api';
import { go, useDebounced } from '../lib/hooks';
import type { FolderRow } from '../lib/types';

const ROW = 46;

export function FoldersView({
  search,
  scrollParent,
}: {
  readonly search: string;
  readonly scrollParent: HTMLElement | null;
}) {
  const [rows, setRows] = useState<readonly FolderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useDebounced(search.trim().toLowerCase(), 200);

  useEffect(() => {
    const controller = new AbortController();
    api
      .folders(undefined, undefined, controller.signal)
      .then(data => setRows(data.folders))
      .catch((e: unknown) => {
        if (!isAbort(e)) setError((e as Error).message);
      });
    return () => controller.abort();
  }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    if (!q) return rows;
    return rows.filter(row => `${row.folder} ${row.author ?? ''}`.toLowerCase().includes(q));
  }, [rows, q]);

  // A new filter starts at the top of the list.
  useEffect(() => {
    if (scrollParent) scrollParent.scrollTop = 0;
  }, [q, scrollParent]);

  const open = useCallback((row: FolderRow) => {
    go(
      `#/folder/${encodeURIComponent(row.root_label)}/` +
        `${encodeURIComponent(row.shelf)}/${encodeURIComponent(row.folder)}`,
    );
  }, []);

  if (error) return <div className="err">{error}</div>;
  if (!shown) return <Delayed active />;
  if (!shown.length) return <div className="empty">フォルダがありません</div>;

  return (
    <>
      <div className="shelfbar">
        <span className="sub">{shown.length.toLocaleString()} フォルダ</span>
      </div>
      <div className="flist-head">
        <span>棚</span>
        <span>フォルダ</span>
        <span>冊数</span>
      </div>
      <VirtualList
        items={shown}
        rowHeight={ROW}
        scrollParent={scrollParent}
        rowKey={row => `${row.root_label}/${row.shelf}/${row.folder}`}
        render={row => {
          // A nested folder is shown by its own name, with the path above it
          // as context rather than as the thing to read.
          const at = row.folder.lastIndexOf('/');
          const name = at >= 0 ? row.folder.slice(at + 1) : row.folder;
          const above = at >= 0 ? row.folder.slice(0, at) : '';
          return (
            <button className="frow" onClick={() => open(row)} title={row.folder}>
              <span className="f-shelf">{row.shelf || row.root_label}</span>
              <span className="f-name">
                <span className="n1">{name}</span>
                {above ? <span className="n2">{above}</span> : null}
              </span>
              <span className="f-count">
                {row.n_books}
                {row.n_formats > 1 ? <em> · {row.n_formats}形式</em> : null}
              </span>
            </button>
          );
        }}
      />
    </>
  );
}
