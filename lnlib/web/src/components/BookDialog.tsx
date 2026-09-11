/* One book, over the shelf rather than instead of it.

   There is no series page any more and a volume is a short list of facts, so a
   whole view for it was mostly empty space and a lost scroll position. It is a
   dialog now: the shelf stays exactly where it was behind it, and because the
   dialog is still a route, the back button and a pasted link both work.

   Deleting is a second step *inside* the same dialog rather than a second
   dialog on top of it — one scrim, one thing to dismiss, and the book you are
   about to remove stays on screen while you choose what to do with it. */

import { useCallback, useEffect, useRef, useState } from "react";
import { Cover } from "./Cover";
import { Delayed } from "./Delayed";
import { api, invalidate, isAbort } from "../lib/api";
import { forgetBook } from "../lib/shelf";
import { go } from "../lib/hooks";
import { bytes, formatLabel, READABLE } from "../lib/types";
import type { Book, BookCard } from "../lib/types";

interface BookDialogProps {
  readonly id: number;
  readonly onClose: () => void;
  /** Called after the index changes, so the sidebar counts catch up. */
  readonly onChange: () => void;
}

export function BookDialog({ id, onClose, onChange }: BookDialogProps) {
  const [data, setData] = useState<{ book: Book; nearby: readonly BookCard[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<"book" | "delete">("book");
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    setStep("book");
    api.book(id, controller.signal)
      .then(setData)
      .catch((e: unknown) => { if (!isAbort(e)) setError((e as Error).message); });
    return () => controller.abort();
  }, [id]);

  useEffect(() => {
    boxRef.current?.focus();
  }, [data]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      // Escape backs out of the delete step first; it does not throw away the
      // whole dialog because you changed your mind about one button.
      if (step === "delete") setStep("book");
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [step, onClose]);

  const forgetProgress = useCallback(async () => {
    setBusy(true);
    try {
      await api.clearProgress(id);
      invalidate();
      setData(await api.book(id));
      onChange();
    } catch (e) { setError((e as Error).message); }
    setBusy(false);
  }, [id, onChange]);

  const remove = useCallback(async (file: "keep" | "trash") => {
    setBusy(true);
    try {
      const res = await api.deleteBook(id, file);
      if (!res.ok) {
        setError(res.reason || "削除できませんでした");
        setBusy(false);
        setStep("book");
        return;
      }
      invalidate();
      forgetBook(id);          // drop it from the grid without reloading it
      onChange();
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      setStep("book");
    }
  }, [id, onChange, onClose]);

  return (
    <div className="scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div
        className="dialog bookdialog"
        role="dialog"
        aria-modal="true"
        aria-label={data ? data.book.title : "本の詳細"}
        tabIndex={-1}
        ref={boxRef}
      >
        <button className="dialog-x" onClick={onClose} aria-label="閉じる">×</button>

        {error ? <div className="err" onClick={() => setError(null)}>{error}</div> : null}
        {!data && !error ? <Delayed active /> : null}

        {data ? (
          step === "book"
            ? <BookBody
                data={data}
                busy={busy}
                onDelete={() => setStep("delete")}
                onForgetProgress={forgetProgress}
                onClose={onClose}
              />
            : <DeleteBody
                book={data.book}
                busy={busy}
                onBack={() => setStep("book")}
                onConfirm={remove}
              />
        ) : null}
      </div>
    </div>
  );
}

function BookBody({ data, busy, onDelete, onForgetProgress, onClose }: {
  readonly data: { book: Book; nearby: readonly BookCard[] };
  readonly busy: boolean;
  readonly onDelete: () => void;
  readonly onForgetProgress: () => void;
  readonly onClose: () => void;
}) {
  const { book, nearby } = data;
  const percent = Math.round((book.read_percent || 0) * 100);
  const readable = READABLE.has(book.format) && book.present;
  const others = nearby.filter((n) => n.id !== book.id);

  return (
    <>
      {!book.present ? (
        <div className="warnbar">
          最後のスキャンではこのファイルが見つかりませんでした。開こうとして本当に
          無いと分かった時点で片付けます。
        </div>
      ) : null}

      <div className="bd-head">
        <div className="bd-cover">
          <div className="thumb">
            <Cover bookId={book.id} state={book.cover_state} alt="" />
          </div>
        </div>

        <div className="bd-meta">
          <h3 className="mincho">{book.title}</h3>
          <div className="byline">{book.author || "作者不明"}</div>

          <div className="chips">
            <span className="chip">{formatLabel(book.format)}</span>
            {book.volume ? <span className="chip">第{book.volume}巻</span> : null}
            {book.date ? <span className="chip">{book.date}</span> : null}
            {book.is_extra ? <span className="chip">特典</span> : null}
            {!book.present ? <span className="chip miss">見つからない</span> : null}
            {book.read_finished
              ? <span className="chip ok">読了</span>
              : percent > 0 ? <span className="chip ok">{percent}%</span> : null}
            {book.size ? <span className="chip">{bytes(book.size)}</span> : null}
          </div>

          <dl className="facts">
            <Fact k="レーベル" v={book.imprint} />
            <Fact k="イラスト" v={book.illustrator} />
            <Fact k="棚" v={[book.root_label, book.shelf].filter(Boolean).join(" / ")} />
            <Fact k="フォルダ" v={book.folder || null} />
          </dl>
          <div className="path" title={book.path}>{book.path}</div>
        </div>
      </div>

      {others.length ? (
        <div className="bd-folder">
          <h4 className="section">同じフォルダ · {others.length}</h4>
          <ul className="bd-siblings">
            {others.map((row) => (
              <li key={row.id}>
                <button
                  className={row.present ? "" : "gone"}
                  onClick={() => go(`#/book/${row.id}`)}
                  title={row.title}
                >
                  <span className="v">{row.volume ? `${row.volume}` : "—"}</span>
                  <span className="t">{row.title}</span>
                  <span className="d">{row.date?.slice(0, 7) || ""}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="dialog-actions spread">
        <button className="danger" onClick={onDelete} disabled={busy}>
          棚から外す
        </button>
        <div className="grow" />
        {book.read_at ? (
          <button onClick={onForgetProgress} disabled={busy}>記録を消す</button>
        ) : null}
        <button onClick={() => void api.reveal(book.path)}>フォルダ</button>
        {book.present ? (
          <button onClick={() => void api.open(book.path)}>外部</button>
        ) : null}
        {readable ? (
          <button
            className="pri"
            onClick={() => { onClose(); go(`#/read/${book.id}`); }}
          >
            {percent > 0 && !book.read_finished ? "続きを読む" : "読む"}
          </button>
        ) : null}
      </div>
    </>
  );
}

function DeleteBody({ book, busy, onBack, onConfirm }: {
  readonly book: Book;
  readonly busy: boolean;
  readonly onBack: () => void;
  readonly onConfirm: (file: "keep" | "trash") => void;
}) {
  const [choice, setChoice] = useState<"keep" | "trash">("keep");
  return (
    <>
      <h3 className="bd-ask">棚から外しますか</h3>
      <p className="dialog-book">
        <b>{book.title}</b>
        <span className="dim">{book.author || "作者不明"} · {bytes(book.size)}</span>
      </p>

      <label className={`choice${choice === "keep" ? " on" : ""}`}>
        <input type="radio" name="delete-file" checked={choice === "keep"}
               onChange={() => setChoice("keep")} />
        <span>
          <b>記録だけ削除</b>
          <em>ファイルはそのまま残ります。次のスキャンでまた見つかります。</em>
        </span>
      </label>

      <label className={`choice${choice === "trash" ? " on" : ""}`}>
        <input type="radio" name="delete-file" checked={choice === "trash"}
               onChange={() => setChoice("trash")} />
        <span>
          <b>ファイルもゴミ箱へ</b>
          <em>
            同じドライブの <code>_trash</code> に移動します。ゴミ箱からいつでも
            元に戻せます。
          </em>
        </span>
      </label>

      <p className="path">{book.path}</p>

      <div className="dialog-actions">
        <button onClick={onBack} disabled={busy}>やめる</button>
        <button
          className={choice === "trash" ? "danger solid" : "pri"}
          onClick={() => onConfirm(choice)}
          disabled={busy}
        >
          {busy ? "…" : choice === "trash" ? "ゴミ箱へ移動" : "記録を削除"}
        </button>
      </div>
    </>
  );
}

function Fact({ k, v }: { readonly k: string; readonly v: string | null }) {
  if (!v) return null;
  return (
    <div className="fact">
      <dt>{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
