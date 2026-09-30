/* Confirming, running and reporting one batch action.

   Three steps in one dialog: what is about to happen and to how many books;
   a busy state while it runs (moving a few thousand files takes a while); and
   what happened -- how many were done, and for anything that was not, why.
   A batch that half-fails is reported as such rather than as a success. */

import { useEffect, useRef, useState } from "react";
import type { BatchResult } from "../lib/types";

export type BatchKind = "remove" | "clear" | "restore" | "purge";

interface BatchDialogProps {
  readonly kind: BatchKind;
  readonly count: number;
  /** Resolves with what the server did; rejects with a message to show. */
  readonly run: (choice: "keep" | "trash") => Promise<BatchResult>;
  readonly onClose: (changed: boolean) => void;
}

const TITLES: Record<BatchKind, string> = {
  remove: "棚から外す",
  clear: "読書記録を消す",
  restore: "ゴミ箱から戻す",
  purge: "完全に削除",
};

export function BatchDialog({ kind, count, run, onClose }: BatchDialogProps) {
  const [choice, setChoice] = useState<"keep" | "trash">("keep");
  const [step, setStep] = useState<"ask" | "busy" | "done">("ask");
  const [result, setResult] = useState<BatchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => { boxRef.current?.focus(); }, [step]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || step === "busy") return;
      e.preventDefault();
      e.stopPropagation();
      onClose(step === "done");
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, onClose]);

  const go = async () => {
    setStep("busy");
    setError(null);
    try {
      setResult(await run(choice));
      setStep("done");
    } catch (e) {
      setError((e as Error).message);
      setStep("ask");
    }
  };

  const danger = kind === "purge" || (kind === "remove" && choice === "trash");
  // The whole phrase per action rather than a verb slotted into one template:
  // Japanese particles do not survive that kind of assembly.
  const n = count.toLocaleString();
  const confirm = kind === "remove"
    ? (choice === "trash" ? `${n} 冊をゴミ箱へ移動` : `${n} 冊の記録を削除`)
    : kind === "clear" ? `${n} 冊の読書記録を消す`
    : kind === "restore" ? `${n} 冊を戻す` : `${n} 冊を完全に削除`;

  return (
    <div className="scrim" onMouseDown={(e) => {
      if (e.target === e.currentTarget && step !== "busy") onClose(step === "done");
    }}>
      <div className="dialog batchdialog" role="dialog" aria-modal="true"
           aria-label={TITLES[kind]} tabIndex={-1} ref={boxRef}>
        <h3>{TITLES[kind]}</h3>

        {step === "done" && result ? (
          <>
            <p className={`bd-result${result.failed ? " partial" : ""}`}>
              {result.done.toLocaleString()} / {result.total.toLocaleString()} 冊を処理しました
              {result.failed ? `（${result.failed} 冊は失敗）` : ""}
            </p>
            {result.failures.length ? (
              <ul className="bd-failures">
                {result.failures.map((f) => (
                  <li key={f.id}>
                    <b>{f.title || `#${f.id}`}</b>
                    <span>{f.reason}</span>
                  </li>
                ))}
                {result.failed > result.failures.length ? (
                  <li className="dim">ほか {result.failed - result.failures.length} 件</li>
                ) : null}
              </ul>
            ) : null}
            <div className="dialog-actions">
              <button className="pri" onClick={() => onClose(true)}>閉じる</button>
            </div>
          </>
        ) : (
          <>
            <p className="bd-count">
              <b>{count.toLocaleString()}</b> 冊が対象です
            </p>

            {kind === "remove" ? (
              <>
                <label className={`choice${choice === "keep" ? " on" : ""}`}>
                  <input type="radio" name="batch-file" checked={choice === "keep"}
                         onChange={() => setChoice("keep")} disabled={step === "busy"} />
                  <span>
                    <b>記録だけ削除</b>
                    <em>ファイルはそのまま残ります。次のスキャンでまた見つかります。</em>
                  </span>
                </label>
                <label className={`choice${choice === "trash" ? " on" : ""}`}>
                  <input type="radio" name="batch-file" checked={choice === "trash"}
                         onChange={() => setChoice("trash")} disabled={step === "busy"} />
                  <span>
                    <b>ファイルもゴミ箱へ</b>
                    <em>
                      それぞれ同じドライブの <code>_trash</code> に移動します。
                      ゴミ箱からいつでも元に戻せます。
                    </em>
                  </span>
                </label>
              </>
            ) : kind === "clear" ? (
              <p className="dim">どこまで読んだかの記録が消えます。本とファイルはそのままです。</p>
            ) : kind === "restore" ? (
              <p className="dim">
                ゴミ箱に移したファイルは元の場所に戻ります。元の場所に別のファイルがある本は戻せません。
              </p>
            ) : (
              <p className="warn-text">
                ゴミ箱に移したファイルはディスクから削除され、元に戻せません。
                「記録だけ削除」した本のファイルには触れません。
              </p>
            )}

            {error ? <div className="err">{error}</div> : null}

            <div className="dialog-actions">
              <button onClick={() => onClose(false)} disabled={step === "busy"}>
                やめる
              </button>
              <button className={danger ? "danger solid" : "pri"} onClick={go}
                      disabled={step === "busy"}>
                {step === "busy" ? "処理中…" : confirm}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
