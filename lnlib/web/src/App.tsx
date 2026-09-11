/* The shelf.

   One document, hash routing. The chrome is shared and stays mounted across
   navigations, which is what lets the grid keep its rows and its scroll offset
   when a book is opened and closed again.

   A book is a dialog rather than a view of its own: the shelf keeps rendering
   underneath it. It is still a route, so the back button closes it and a link
   to one opens straight onto it -- `beneath` is what the shelf falls back to
   when a link like that arrives with no history behind it. */

import { useCallback, useEffect, useState } from "react";
import { Sidebar } from "./components/Sidebar";
import { ShelfView } from "./views/ShelfView";
import { BookDialog } from "./components/BookDialog";
import { ReadingView } from "./views/ReadingView";
import { FoldersView } from "./views/FoldersView";
import { FormatsView } from "./views/FormatsView";
import { TrashView } from "./views/TrashView";
import { ReaderView } from "./views/ReaderView";
import { api, invalidate, isAbort } from "./lib/api";
import { forgetShelves } from "./lib/shelf";
import * as Thumbs from "./lib/thumbs";
import { formatLabel } from "./lib/types";
import { go, useRoute, type Route } from "./lib/hooks";
import type { Overview } from "./lib/types";

export default function App() {
  const route = useRoute();
  // The last view that was not a book, so the dialog always has a shelf behind
  // it -- including when someone opens a link to one in a fresh tab.
  const [beneath, setBeneath] = useState<Route>(
    () => (isOverlay(route) ? { view: "shelf" } : route));
  const [overview, setOverview] = useState<Overview | null>(null);
  const [readingCount, setReadingCount] = useState(0);
  const [search, setSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanNote, setScanNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A callback ref in state rather than a plain ref: the grid measures itself
  // against this element, and a ref would still be null on the commit they
  // mount together. Setting state re-renders with the element in hand.
  const [content, setContent] = useState<HTMLElement | null>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const data = await api.overview(signal);
      setOverview(data);
      // Book ids survive a rescan now, so the thumbnail cache is stamped with
      // the incarnation of the index rather than the time of the last scan --
      // otherwise every 再スキャン threw away thousands of usable thumbnails.
      void Thumbs.checkGeneration(data.index_epoch);
      const reading = await api.reading(200, signal);
      setReadingCount(reading.books.filter((row) => !row.finished).length);
    } catch (e) {
      if (!isAbort(e)) setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    if (!isOverlay(route)) setBeneath(route);
  }, [route]);

  const rescan = useCallback(async () => {
    setScanning(true);
    setScanNote(null);
    try {
      const result = await api.scan();
      invalidate();
      forgetShelves();
      await refresh();
      const parts = [];
      if (result.new) parts.push(`新規 ${result.new}`);
      if (result.updated) parts.push(`更新 ${result.updated}`);
      if (result.returned) parts.push(`復帰 ${result.returned}`);
      if (result.vanished) parts.push(`不明 ${result.vanished}`);
      setScanNote(parts.length ? parts.join(" / ") : "変更なし");
      window.setTimeout(() => setScanNote(null), 6000);
    } catch (e) {
      setError((e as Error).message);
    }
    setScanning(false);
  }, [refresh]);

  // The reader takes the whole window: it owns the keyboard and the page turns,
  // and a sidebar beside it is only something to lose focus to.
  if (route.view === "read") {
    return <ReaderView key={route.id} id={route.id} onChange={refresh} />;
  }

  // The chrome describes what is behind the dialog, not the dialog.
  const heading = headingFor(beneath, overview);
  const searchable = beneath.view === "shelf" || beneath.view === "folders";
  const closeBook = () => {
    if (history.length > 1) history.back();
    else go(hashFor(beneath));
  };

  return (
    <div id="app" className={menuOpen ? "menu-open" : ""}>
      <div className="scrim-nav" onClick={() => setMenuOpen(false)} />
      <Sidebar
        overview={overview}
        route={route}
        readingCount={readingCount}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        onScan={rescan}
        scanning={scanning}
        scanNote={scanNote}
      />
      <main id="main">
        <div className="topbar">
          <button className="menu-btn sm" onClick={() => setMenuOpen((v) => !v)}
                  aria-label="メニュー">
            ☰
          </button>
          <h2>{heading}</h2>
          {searchable ? (
            <input
              type="search"
              id="q"
              value={search}
              placeholder="作者・作品名で絞り込む"
              autoComplete="off"
              onChange={(e) => setSearch(e.target.value)}
            />
          ) : null}
        </div>

        <div className="content" ref={setContent}>
          {error ? (
            <div className="err" onClick={() => setError(null)}>{error}</div>
          ) : null}

          <Body
            route={beneath}
            content={content}
            search={search}
            onCount={setReadingCount}
            onChange={refresh}
          />
        </div>
      </main>

      {route.view === "book" ? (
        <BookDialog key={route.id} id={route.id} onClose={closeBook}
                    onChange={refresh} />
      ) : null}
    </div>
  );
}

/** Routes that are drawn over a view rather than being one.

    The reader counts as well as the dialog: 詳細 inside the reader opens the
    dialog, and if the reader had been recorded as what lies beneath it the
    dialog would have arrived over a blank page. */
const isOverlay = (route: Route) =>
  route.view === "book" || route.view === "read";

/** The hash a route came from, for closing a dialog with nothing behind it. */
function hashFor(route: Route): string {
  switch (route.view) {
    case "reading": return "#/reading";
    case "folders": return "#/folders";
    case "formats": return "#/formats";
    case "trash": return "#/trash";
    case "shelf":
      if (route.only) return `#/${route.only}`;
      if (route.format) return `#/format/${encodeURIComponent(route.format)}`;
      if (route.folder) {
        return `#/folder/${encodeURIComponent(route.root ?? "")}/` +
               `${encodeURIComponent(route.shelf ?? "")}/` +
               `${encodeURIComponent(route.folder)}`;
      }
      if (route.root) {
        return `#/shelf/${encodeURIComponent(route.root)}/` +
               `${encodeURIComponent(route.shelf ?? "")}`;
      }
      return "#/all";
    default: return "#/all";
  }
}

function Body({ route, content, search, onCount, onChange }: {
  readonly route: Route;
  readonly content: HTMLElement | null;
  readonly search: string;
  readonly onCount: (n: number) => void;
  readonly onChange: () => void;
}) {
  switch (route.view) {
    case "reading":
      return <ReadingView onCount={onCount} />;
    case "folders":
      return <FoldersView search={search} />;
    case "formats":
      return <FormatsView />;
    case "trash":
      return <TrashView onChange={onChange} />;
    case "book":
    case "read":
      // Neither is ever rendered here: a book is a dialog over whatever this
      // is, and the reader replaces the chrome entirely.
      return null;
    case "shelf":
    default:
      return (
        <ShelfView
          key={[route.root, route.shelf, route.folder, route.format,
                route.only].join("|")}
          route={route}
          scrollParent={content}
          search={search}
        />
      );
  }
}

function headingFor(route: Route, overview: Overview | null): string {
  switch (route.view) {
    case "reading": return "読書中";
    case "folders": return "フォルダ";
    case "formats": return "形式";
    case "trash": return "ゴミ箱";
    case "book": return "本の詳細";
    case "read": return "";
    default: break;
  }
  if (route.only === "absent") return "見つからない本";
  if (route.only === "undated") return "日付なし";
  if (route.format) return formatLabel(route.format);
  if (route.folder) return route.folder;
  if (route.shelf) return route.shelf;
  if (route.root) return route.root;
  return overview ? "すべて" : "蔵書";
}
