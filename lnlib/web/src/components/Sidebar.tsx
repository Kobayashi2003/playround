import { useEffect, useState } from 'react';
import { go, type Route } from '../lib/hooks';
import { formatLabel } from '../lib/types';
import type { Overview } from '../lib/types';

interface SidebarProps {
  readonly overview: Overview | null;
  readonly route: Route;
  readonly readingCount: number;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onScan: () => void;
  readonly scanning: boolean;
  readonly scanNote: string | null;
}

export function Sidebar({
  overview,
  route,
  readingCount,
  open,
  onClose,
  onScan,
  scanning,
  scanNote,
}: SidebarProps) {
  const totals = overview?.totals ?? {};
  const byRoot = new Map<string, Overview['shelves'][number][]>();
  for (const shelf of overview?.shelves ?? []) {
    const list = byRoot.get(shelf.root_label) ?? [];
    list.push(shelf);
    byRoot.set(shelf.root_label, list);
  }

  /* Which entry is lit. Comparing the route's own fields rather than a
     flattened key keeps this readable and cannot drift when a field is added. */
  const shelfAt = (root?: string, shelf?: string, only?: string, format?: string) =>
    route.view === 'shelf' &&
    (route.root ?? '') === (root ?? '') &&
    (route.shelf ?? '') === (shelf ?? '') &&
    !route.folder &&
    (route.format ?? '') === (format ?? '') &&
    (route.only ?? '') === (only ?? '');

  return (
    <aside id="side" className={open ? 'open' : ''}>
      <div className="brand">
        <h1 className="mincho">蔵書棚</h1>
        <span className="v">lnlib</span>
      </div>
      <nav className="nav" onClick={onClose}>
        <div className="grp">全体</div>
        <NavLink
          hash="#/reading"
          label="読書中"
          count={readingCount || ''}
          on={route.view === 'reading'}
        />
        <NavLink hash="#/all" label="すべて" count={totals.n_books ?? 0} on={shelfAt()} />
        <NavLink
          hash="#/undated"
          label="日付なし"
          count={totals.n_undated ?? 0}
          on={shelfAt(undefined, undefined, 'undated')}
        />
        {totals.n_absent ? (
          <NavLink
            hash="#/absent"
            label="見つからない"
            count={totals.n_absent}
            on={shelfAt(undefined, undefined, 'absent')}
            warn
          />
        ) : null}

        <div className="grp">形式</div>
        <NavLink hash="#/formats" label="内訳を見る" count="" on={route.view === 'formats'} />
        {(overview?.formats ?? []).map(f => (
          <NavLink
            key={f.format}
            hash={`#/format/${encodeURIComponent(f.format)}`}
            label={formatLabel(f.format)}
            count={f.n_books}
            on={shelfAt(undefined, undefined, undefined, f.format)}
          />
        ))}

        {[...byRoot].map(([root, shelves]) => (
          <div key={root}>
            <div className="grp">{root}</div>
            {shelves.map(shelf => {
              const hash =
                `#/shelf/${encodeURIComponent(root)}/` + `${encodeURIComponent(shelf.shelf)}`;
              return (
                <NavLink
                  key={shelf.shelf}
                  hash={hash}
                  label={shelf.shelf || '（直下）'}
                  count={shelf.n_books}
                  on={shelfAt(root, shelf.shelf)}
                />
              );
            })}
          </div>
        ))}

        <div className="grp">整理</div>
        <NavLink hash="#/folders" label="フォルダ" count="" on={route.view === 'folders'} />
        <NavLink
          hash="#/trash"
          label="ゴミ箱"
          count={overview?.n_trash || ''}
          on={route.view === 'trash'}
        />
      </nav>
      <div className="sidefoot">
        <ThemeButton />
        <button
          className="sm"
          onClick={onScan}
          disabled={scanning}
          title="ディスクを読み直す。見つからない本の記録は残ります"
        >
          {scanning ? 'スキャン中…' : '再スキャン'}
        </button>
        {scanNote ? <div className="scannote">{scanNote}</div> : null}
      </div>
    </aside>
  );
}

function NavLink({
  hash,
  label,
  count,
  on,
  warn,
}: {
  readonly hash: string;
  readonly label: string;
  readonly count: number | string;
  readonly on: boolean;
  readonly warn?: boolean;
}) {
  return (
    <a
      href={hash}
      className={`${on ? 'on' : ''}${warn ? ' warn' : ''}`}
      onClick={e => {
        e.preventDefault();
        go(hash);
      }}
    >
      <span className="lbl">{label}</span>
      {count !== '' && count != null ? <span className="n">{count}</span> : null}
    </a>
  );
}

/* The theme is a document attribute rather than React state: index.html sets it
   before the first paint so the shelf never flashes the wrong colours, and this
   only has to keep the two in step. */
function ThemeButton() {
  const [theme, setTheme] = useState<string | null>(() =>
    document.documentElement.getAttribute('data-theme'),
  );
  useEffect(() => {
    if (theme) document.documentElement.setAttribute('data-theme', theme);
    else document.documentElement.removeAttribute('data-theme');
  }, [theme]);

  return (
    <button
      className="sm"
      title="表示テーマ"
      onClick={() => {
        const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        const next = theme ? (theme === 'dark' ? 'light' : 'dark') : dark ? 'light' : 'dark';
        try {
          localStorage.setItem('lnlib.theme', next);
        } catch {
          /* private mode */
        }
        setTheme(next);
      }}
    >
      ◐ テーマ
    </button>
  );
}
