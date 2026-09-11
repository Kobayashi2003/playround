/* Opening a book.

   The frame is the same whatever the format; what fills it is not. The EPUB
   engine and the image reader are both loaded on demand, so a session that
   only browses the shelf never downloads either of them.

   This is also where a record dies. A scan that cannot find a file only marks
   it, because the usual reason is an unplugged drive; opening the book is the
   moment the absence is actually tested, and the server retires the row then
   -- into the trash, so it can still be put back. */

import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Delayed } from "../components/Delayed";
import { api, invalidate, isAbort } from "../lib/api";
import { forgetBook } from "../lib/shelf";
import { bookRaw } from "../lib/mount";
import { go } from "../lib/hooks";
import type { Manifest } from "../lib/types";

const EpubReaderView = lazy(() => import("../reader/EpubReaderView"));
const ImageReaderView = lazy(() => import("../reader/ImageReaderView"));
const TextReaderView = lazy(() => import("../reader/TextReaderView"));

export function ReaderView({ id, onChange }: {
  readonly id: number;
  readonly onChange: () => void;
}) {
  const [data, setData] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    api.manifest(id, controller.signal)
      .then((manifest) => {
        setData(manifest);
        // The server has just taken this book out of the index; the shelf
        // behind us is holding a row that no longer exists.
        if (manifest.kind === "gone" && manifest.retired) {
          invalidate();
          forgetBook(id);
          onChange();
        }
      })
      .catch((e: unknown) => { if (!isAbort(e)) setError((e as Error).message); });
    return () => controller.abort();
  }, [id, onChange]);

  // The shelf is behind the reader, not replaced by it: leaving is a history
  // step, so the back button works and the grid comes back where it was.
  const leave = useCallback(() => {
    if (history.length > 1) history.back();
    else go("#/all");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc inside the reader's own panels belongs to the reader; only an Esc
      // that nothing else claimed should close the book.
      if (e.key === "Escape" && !e.defaultPrevented) leave();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [leave]);

  if (error) {
    return (
      <div className="readerframe">
        <ReaderBar title="開けません" onLeave={leave} />
        <div className="readerbody"><div className="err">{error}</div></div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="readerframe">
        <ReaderBar title="" onLeave={leave} />
        <div className="readerbody"><Delayed active /></div>
      </div>
    );
  }

  const { book } = data;
  const plain = data.kind !== "epub" && data.kind !== "pdf";

  return (
    <div className="readerframe" data-kind={data.kind}>
      <ReaderBar
        title={book.title}
        subtitle={[book.author, book.imprint].filter(Boolean).join(" · ")}
        onLeave={leave}
        bookId={data.kind === "gone" ? undefined : book.id}
        onOpen={data.kind === "gone" ? undefined : () => void api.open(book.path)}
      />
      <div className={`readerbody${plain ? " plain" : ""}`}>
        <Suspense fallback={<Delayed active after={120}>準備しています…</Delayed>}>
          {data.kind === "epub" ? (
            <EpubReaderView book={book} progress={data.progress} />
          ) : data.kind === "images" ? (
            <ImageReaderView
              book={book}
              pages={data.pages}
              direction={data.direction}
              progress={data.progress}
            />
          ) : data.kind === "text" ? (
            <TextReaderView book={book} text={data.text} encoding={data.encoding}
                            progress={data.progress} />
          ) : data.kind === "pdf" ? (
            // The browser has a PDF viewer and it is better than anything that
            // would fit in here; the file is simply handed to it.
            <iframe className="pdfframe" src={bookRaw(book.id)} title={book.title} />
          ) : (
            <div className="empty">
              <p>{data.detail || "この本は開けません"}</p>
              <p className="dim">{book.filename}</p>
              <div className="actions center">
                {data.kind === "gone" ? (
                  <button className="pri" onClick={leave}>棚に戻る</button>
                ) : (
                  <>
                    <button onClick={() => void api.open(book.path)}>
                      外部アプリで開く
                    </button>
                    <button onClick={() => void api.reveal(book.path)}>
                      フォルダを開く
                    </button>
                  </>
                )}
              </div>
              {data.kind === "gone" && data.retired ? (
                <p className="dim">
                  ゴミ箱に移しました。戻したいときはゴミ箱から復元できます。
                </p>
              ) : null}
            </div>
          )}
        </Suspense>
      </div>
    </div>
  );
}

function ReaderBar({ title, subtitle, onLeave, onOpen, bookId }: {
  readonly title: string;
  readonly subtitle?: string;
  readonly onLeave: () => void;
  readonly onOpen?: () => void;
  readonly bookId?: number;
}) {
  return (
    <div className="rbar">
      <button className="sm" onClick={onLeave} title="棚に戻る（Esc）">← 棚</button>
      <div className="rtitle">
        <b>{title}</b>
        {subtitle ? <span>{subtitle}</span> : null}
      </div>
      {bookId ? (
        <button className="sm" onClick={() => go(`#/book/${bookId}`)}>詳細</button>
      ) : null}
      {onOpen ? <button className="sm" onClick={onOpen}>外部</button> : null}
    </div>
  );
}
