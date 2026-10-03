/* The e-book reader.

   The whole engine lives in `src/epub-reader`, copied from component-atlas: it
   opens the container, reads the package, paginates and renders, and there is
   no second e-book implementation anywhere in this project. It takes EPUB and
   Kindle KF8 (.azw3, and the KF8 part of a .mobi) alike, deciding which it was
   given from the first bytes, so nothing here has to tell it. What this file
   does is the part that is ours -- getting the bytes off the shelf and telling
   the shelf where the reading got to.

   This module is the lazy chunk. Nothing in it is fetched, parsed or evaluated
   until a book is actually opened, which is why the shelf itself stays small. */

import { useEffect, useState } from "react";
import { EpubReader } from "../epub-reader/react";
import type { BrowserEpubReaderSnapshot } from "../epub-reader/core";
import "../epub-reader/styles.css";
import { bookRaw } from "../lib/mount";
import { Delayed } from "../components/Delayed";
import { createShelfSession } from "./session";
import type { Book, Progress } from "../lib/types";

/* Bytes already fetched, kept for as long as the shelf is likely to want them
   back. A book is ten megabytes and the local server is fast, but re-reading
   one still costs a second of blank screen, and leaving a book to check the
   shelf and coming straight back is the most ordinary thing a reader does. */
const BLOBS = new Map<number, Blob>();
const MAX_BLOBS = 3;

function keep(id: number, blob: Blob): void {
  BLOBS.set(id, blob);
  while (BLOBS.size > MAX_BLOBS) {
    const oldest = BLOBS.keys().next().value;
    if (oldest === undefined || oldest === id) break;
    BLOBS.delete(oldest);
  }
}

const MIME: Record<string, string> = {
  ".epub": "application/epub+zip",
  ".azw3": "application/vnd.amazon.ebook",
  ".mobi": "application/x-mobipocket-ebook",
};

async function fetchBook(
  id: number,
  ext: string,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<Blob> {
  const cached = BLOBS.get(id);
  if (cached) {
    // Re-inserting keeps the map in least-recently-used order.
    BLOBS.delete(id);
    BLOBS.set(id, cached);
    return cached;
  }

  const res = await fetch(bookRaw(id), { signal });
  if (!res.ok) throw new Error(`本を読み込めません (HTTP ${res.status})`);

  const total = Number(res.headers.get("content-length") || 0);
  if (!res.body || !total) {
    const whole = await res.blob();
    keep(id, whole);
    return whole;
  }

  // Reading the stream rather than calling .blob() is only worth it because the
  // progress it reports is what the reader shows while a large book opens.
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    onProgress(Math.min(1, received / total));
  }
  // The engine reads the bytes rather than the label, but a blob that says
  // what it holds is easier to pass around.
  const type = MIME[ext.toLowerCase()] ?? "application/octet-stream";
  const blob = new Blob(chunks as BlobPart[], { type });
  keep(id, blob);
  return blob;
}

interface EpubReaderViewProps {
  readonly book: Book;
  readonly progress: Progress | null;
}

export default function EpubReaderView({ book, progress }: EpubReaderViewProps) {
  const [source, setSource] = useState<Blob | null>(() => BLOBS.get(book.id) ?? null);
  const [fraction, setFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [session] = useState(() => createShelfSession(book.id, progress));

  /* The session writes on a throttle, so leaving the book -- or the tab -- has
     to push whatever is still pending. React owns these listeners rather than
     the session itself, so that a session object constructed and thrown away
     without ever being mounted cannot leave a handler behind. */
  useEffect(() => {
    const flush = () => session.flush();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [session]);

  useEffect(() => {
    if (source) return;
    const controller = new AbortController();
    let alive = true;
    fetchBook(book.id, book.ext, controller.signal,
              (f) => { if (alive) setFraction(f); })
      .then((blob) => { if (alive) setSource(blob); })
      .catch((e: unknown) => {
        if (!alive || (e as Error).name === "AbortError") return;
        setError((e as Error).message);
      });
    return () => { alive = false; controller.abort(); };
  }, [book.id, source]);

  if (error) return <div className="err">{error}</div>;

  if (!source) {
    return (
      <Delayed active after={220}>
        <div className="opening">
          <div>本を開いています…</div>
          {fraction > 0 ? (
            <div className="bar"><i style={{ width: `${Math.round(fraction * 100)}%` }} /></div>
          ) : null}
        </div>
      </Delayed>
    );
  }

  return (
    <EpubReader
      source={source}
      readerOptions={{
        readingSession: { key: session.key, storage: session.storage },
        onReady: (snapshot: BrowserEpubReaderSnapshot) => {
          // Progress is a fraction of the whole book, and only the opened
          // publication knows how many resources that is.
          session.setSpineLength(snapshot.publication.spine.length);
        },
      }}
    />
  );
}
