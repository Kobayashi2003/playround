/* The content folders on disk.

   This is the closest thing left to a series list, and it is deliberately only
   what the filesystem says: a folder someone made, and how many books are in
   it. Nothing here is inferred from titles. */

import { useEffect, useMemo, useState } from "react";
import { Delayed } from "../components/Delayed";
import { api, isAbort } from "../lib/api";
import { go, useDebounced } from "../lib/hooks";
import type { FolderRow } from "../lib/types";

export function FoldersView({ search }: { readonly search: string }) {
  const [rows, setRows] = useState<readonly FolderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const q = useDebounced(search.trim().toLowerCase(), 200);

  useEffect(() => {
    const controller = new AbortController();
    api.folders(undefined, undefined, controller.signal)
      .then((data) => setRows(data.folders))
      .catch((e: unknown) => { if (!isAbort(e)) setError((e as Error).message); });
    return () => controller.abort();
  }, []);

  const shown = useMemo(() => {
    if (!rows) return null;
    if (!q) return rows;
    return rows.filter((row) =>
      `${row.folder} ${row.author ?? ""}`.toLowerCase().includes(q));
  }, [rows, q]);

  if (error) return <div className="err">{error}</div>;
  if (!shown) return <Delayed active />;
  if (!shown.length) return <div className="empty">フォルダがありません</div>;

  return (
    <table className="vols">
      <thead>
        <tr><th>棚</th><th>フォルダ</th><th>冊数</th><th /></tr>
      </thead>
      <tbody>
        {shown.map((row) => {
          const hash = `#/folder/${encodeURIComponent(row.root_label)}/` +
                       `${encodeURIComponent(row.shelf)}/${encodeURIComponent(row.folder)}`;
          return (
            <tr key={`${row.root_label}/${row.shelf}/${row.folder}`}>
              <td className="dt">{row.shelf || row.root_label}</td>
              <td><div className="name">{row.folder}</div></td>
              <td className="vv">
                {row.n_books} 冊
                {row.n_formats > 1 ? ` · ${row.n_formats} 形式` : ""}
              </td>
              <td className="act">
                <button className="sm" onClick={() => go(hash)}>開く</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
