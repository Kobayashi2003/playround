/* The trash.

   Everything the shelf has stopped showing, and why. `file_state` is the whole
   story of each row: `kept` means only the record went and the file is still
   where it was; `trashed` means the file moved into its root's `_trash` folder
   and comes back with it; `vanished` means the file was already gone when the
   record was retired, so restoring brings back the record alone.

   Rows can be ticked and acted on together. Only 完全に削除 destroys anything,
   and only for rows whose file this shelf actually moved -- forgetting a book
   was never a claim on the file. */

import { useCallback, useEffect, useState } from 'react';
import { Delayed } from '../components/Delayed';
import { BatchDialog, type BatchKind } from '../components/BatchDialog';
import { api, invalidate, isAbort } from '../lib/api';
import { forgetShelves } from '../lib/shelf';
import { useSelection } from '../lib/selection';
import { bytes, formatLabel } from '../lib/types';
import type { TrashRow } from '../lib/types';

const STATE: Record<TrashRow['file_state'], { label: string; hint: string }> = {
  kept: { label: '記録のみ', hint: 'ファイルはディスクに残っています' },
  trashed: { label: 'ゴミ箱', hint: '_trash に移動しました' },
  vanished: { label: '消失', hint: 'ファイルが見つからなくなりました' },
};

export function TrashView({ onChange }: { readonly onChange: () => void }) {
  const [rows, setRows] = useState<readonly TrashRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [batch, setBatch] = useState<{ kind: BatchKind; ids: number[] | 'selection' } | null>(null);
  const picks = useSelection(total);
  const { clear } = picks;

  const load = useCallback((signal?: AbortSignal) => {
    api
      .trash(signal)
      .then(data => {
        setRows(data.items);
        setTotal(data.total);
      })
      .catch((e: unknown) => {
        if (!isAbort(e)) setError((e as Error).message);
      });
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

  const run = useCallback(
    async (kind: BatchKind, ids: number[] | 'selection') => {
      const action = kind === 'restore' ? ('restore' as const) : ('purge' as const);
      const body =
        ids !== 'selection'
          ? { action, ids, expect: ids.length }
          : picks.sel.all
            ? // Everything but the unticked, resolved on the server: the list here
              // shows only the newest entries.
              { action, all: true, exclude: [...picks.sel.ids], expect: picks.count }
            : { action, ids: [...picks.sel.ids], expect: picks.count };
      const result = await api.batchTrash(body);
      after();
      return result;
    },
    [picks, after],
  );

  if (error) return <div className="err">{error}</div>;
  if (!rows) return <Delayed active />;
  if (!rows.length) return <div className="empty">ゴミ箱は空です</div>;

  const shown = rows.length;
  const partial = total > shown;
  const count = batch?.ids === 'selection' ? picks.count : batch ? batch.ids.length : 0;

  return (
    <>
      <div className="shelfbar trashbar">
        <label className="checkall">
          <input
            type="checkbox"
            checked={picks.count > 0 && picks.count === total}
            ref={el => {
              if (el) el.indeterminate = picks.count > 0 && picks.count < total;
            }}
            onChange={() => (picks.count === total ? clear() : picks.selectAll())}
            aria-label="すべて選択"
          />
          <span className="sub">
            {picks.count ? `${picks.count.toLocaleString()} / ` : ''}
            {total.toLocaleString()} 件{partial ? `（新しい ${shown} 件を表示）` : ''}
          </span>
        </label>
        <span className="grow" />
        <button
          className="sm"
          disabled={!picks.count}
          onClick={() => setBatch({ kind: 'restore', ids: 'selection' })}
        >
          選択を戻す
        </button>
        <button
          className="sm danger"
          disabled={!picks.count}
          onClick={() => setBatch({ kind: 'purge', ids: 'selection' })}
        >
          選択を完全に削除
        </button>
      </div>

      <ul className="trashlist">
        {rows.map(row => {
          const state = STATE[row.file_state];
          const picked = picks.isPicked(row.id);
          return (
            <li key={row.id} className={`trashrow${picked ? ' picked' : ''}`}>
              <input
                type="checkbox"
                className="rowcheck"
                checked={picked}
                onChange={() => picks.toggle(row.id, 0)}
                aria-label={`${row.title} を選択`}
              />
              <div className="trashmain">
                <div className="name">{row.title}</div>
                <div className="dim">
                  {row.author || '作者不明'} · {formatLabel(row.format)}
                  {row.size ? ` · ${bytes(row.size)}` : ''} ·{' '}
                  {new Date(row.trashed_at * 1000).toLocaleString()}
                </div>
                <div className="path">{row.trash_path || row.path}</div>
              </div>
              <span className={`chip state-${row.file_state}`} title={state.hint}>
                {state.label}
              </span>
              <div className="trashacts">
                <button className="sm" onClick={() => setBatch({ kind: 'restore', ids: [row.id] })}>
                  戻す
                </button>
                <button
                  className="sm danger"
                  onClick={() => setBatch({ kind: 'purge', ids: [row.id] })}
                >
                  完全に削除
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {batch ? (
        <BatchDialog
          kind={batch.kind}
          count={count}
          run={() => run(batch.kind, batch.ids)}
          onClose={changed => {
            setBatch(null);
            if (changed) clear();
          }}
        />
      ) : null}
    </>
  );
}
