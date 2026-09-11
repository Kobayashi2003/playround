/* The trash.

   Everything the shelf has stopped showing, and why. `file_state` is the whole
   story of each row: `kept` means only the record went and the file is still
   where it was; `trashed` means the file moved into its root's `_trash` folder
   and comes back with it; `vanished` means the file was already gone when the
   record was retired, so restoring brings back the record alone.

   Only 完全に削除 destroys anything, and only for rows whose file this shelf
   actually moved -- forgetting a book was never a claim on the file. */

import { useCallback, useEffect, useState } from "react";
import { Delayed } from "../components/Delayed";
import { api, invalidate, isAbort } from "../lib/api";
import { forgetShelves } from "../lib/shelf";
import { bytes, formatLabel } from "../lib/types";
import type { TrashRow } from "../lib/types";

const STATE: Record<TrashRow["file_state"], { label: string; hint: string }> = {
  kept: { label: "記録のみ", hint: "ファイルはディスクに残っています" },
  trashed: { label: "ゴミ箱", hint: "_trash に移動しました" },
  vanished: { label: "消失", hint: "ファイルが見つからなくなりました" },
};

export function TrashView({ onChange }: { readonly onChange: () => void }) {
  const [rows, setRows] = useState<readonly TrashRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | "all" | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const load = useCallback((signal?: AbortSignal) => {
    api.trash(signal)
      .then((data) => setRows(data.items))
      .catch((e: unknown) => { if (!isAbort(e)) setError((e as Error).message); });
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const after = useCallback(() => {
    invalidate();
    forgetShelves();
    load();
    onChange();
  }, [load, onChange]);

  const restore = async (row: TrashRow) => {
    setBusy(row.id);
    setNote(null);
    try {
      const res = await api.restore(row.id);
      setNote(res.ok
        ? `「${res.title}」を戻しました${res.present ? "" : "（ファイルはまだ見つかりません）"}`
        : res.reason ?? "戻せませんでした");
      after();
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };

  const purge = async (row: TrashRow) => {
    const willDelete = row.file_state === "trashed";
    if (willDelete && !confirm(
      `「${row.title}」のファイルを完全に削除します。元に戻せません。`)) return;
    setBusy(row.id);
    setNote(null);
    try {
      const res = await api.emptyTrash(row.id);
      setNote(res.files_deleted
        ? "ファイルを削除しました"
        : "記録を削除しました（ファイルはそのままです）");
      after();
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };

  const purgeAll = async () => {
    const files = (rows ?? []).filter((r) => r.file_state === "trashed").length;
    if (!confirm(files
      ? `ゴミ箱を空にします。${files} 冊分のファイルが完全に削除されます。`
      : "ゴミ箱の記録をすべて削除します。ファイルには触れません。")) return;
    setBusy("all");
    setNote(null);
    try {
      const res = await api.emptyTrash();
      setNote(`${res.entries} 件を整理し、${res.files_deleted} 件のファイルを削除しました`);
      after();
    } catch (e) { setError((e as Error).message); }
    setBusy(null);
  };

  if (error) return <div className="err">{error}</div>;
  if (!rows) return <Delayed active />;

  return (
    <>
      {note ? <div className="note">{note}</div> : null}
      {!rows.length ? (
        <div className="empty">ゴミ箱は空です</div>
      ) : (
        <>
          <div className="shelfbar">
            <span className="sub">{rows.length} 件</span>
            <button className="danger" onClick={purgeAll} disabled={busy !== null}>
              ゴミ箱を空にする
            </button>
          </div>

          <ul className="trashlist">
            {rows.map((row) => {
              const state = STATE[row.file_state];
              return (
                <li key={row.id} className="trashrow">
                  <div className="trashmain">
                    <div className="name">{row.title}</div>
                    <div className="dim">
                      {row.author || "作者不明"} · {formatLabel(row.format)}
                      {row.size ? ` · ${bytes(row.size)}` : ""} ·{" "}
                      {new Date(row.trashed_at * 1000).toLocaleString()}
                    </div>
                    <div className="path">{row.trash_path || row.path}</div>
                  </div>
                  <span className={`chip state-${row.file_state}`} title={state.hint}>
                    {state.label}
                  </span>
                  <div className="trashacts">
                    <button className="sm" onClick={() => restore(row)}
                            disabled={busy !== null}>
                      戻す
                    </button>
                    <button className="sm danger" onClick={() => purge(row)}
                            disabled={busy !== null}>
                      完全に削除
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
