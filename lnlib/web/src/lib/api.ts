/* Talking to the shelf.

   Three things happen here that the views should not each have to do again:

   * a request that is already in flight is joined rather than repeated, which
     is what keeps a scroll that crosses the same page boundary twice from
     asking for it twice;
   * a completed GET is kept for a short while, so leaving a view and coming
     straight back is free -- the shelf is a local index and the answer is
     still true a few seconds later;
   * an aborted request is not an error worth showing anyone. */

import { url } from "./mount";
import type {
  Book, BookCard, BookPage, FolderRow, FormatDetail, Manifest, Overview,
  ReadingRow, ShelfFormat, ShelfQuery, TrashRow,
} from "./types";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ApiError";
  }
}

/** True for the rejection a caller caused by walking away. */
export const isAbort = (e: unknown) =>
  e instanceof DOMException && e.name === "AbortError";

interface Entry {
  readonly at: number;
  readonly value: unknown;
}

const FRESH_MS = 15_000;      // how long a finished GET stays reusable
const MAX_ENTRIES = 240;

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** The generation everything cached belongs to; a rescan renumbers the books. */
let generation = 0;

/** Throw away everything remembered. Called after a scan, and by the reader
    when it has written progress the shelf would otherwise show stale. */
export function invalidate(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    generation += 1;
    return;
  }
  for (const key of cache.keys()) if (key.includes(prefix)) cache.delete(key);
}

export const cacheGeneration = () => generation;

function remember(key: string, value: unknown): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function request<T>(href: string, init?: RequestInit): Promise<T> {
  const res = await fetch(href, init);
  const type = res.headers.get("content-type") || "";
  const body = type.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    const message =
      (body && typeof body === "object" && "error" in body
        ? String((body as { error: unknown }).error)
        : res.statusText) || `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }
  return body as T;
}

/** A GET, joined with an identical one already running and briefly cached.

    `signal` unsubscribes this caller; it deliberately does not cancel the
    shared request, because a second caller may still be waiting on it. The
    response is small JSON either way -- what is expensive is asking twice. */
export function get<T>(href: string, signal?: AbortSignal): Promise<T> {
  const hit = cache.get(href);
  if (hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.value as T);

  let shared = inflight.get(href) as Promise<T> | undefined;
  if (!shared) {
    shared = request<T>(href).then(
      (value) => {
        inflight.delete(href);
        remember(href, value);
        return value;
      },
      (error) => {
        inflight.delete(href);
        throw error;
      },
    );
    inflight.set(href, shared as Promise<unknown>);
  }

  if (!signal) return shared;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    shared!.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

const abortError = () => new DOMException("aborted", "AbortError");

export async function post<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(url(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data ?? {}),
    keepalive: true,        // a save fired while the page is closing still lands
  });
}

/* ------------------------------------------------------------- endpoints */
export const api = {
  overview: (signal?: AbortSignal) =>
    get<Overview>(url("/api/overview"), signal),

  books: (query: ShelfQuery, offset: number, limit: number, signal?: AbortSignal) =>
    get<BookPage>(url("/api/books", { ...query, offset, limit }), signal),

  book: (id: number, signal?: AbortSignal) =>
    get<{ book: Book; nearby: readonly BookCard[] }>(
      url(`/api/books/${id}`), signal),

  manifest: (id: number, signal?: AbortSignal) =>
    get<Manifest>(url(`/api/book/${id}`), signal),

  folders: (root?: string, shelf?: string, signal?: AbortSignal) =>
    get<{ folders: readonly FolderRow[] }>(url("/api/folders", { root, shelf }), signal),

  formats: (root?: string, shelf?: string, signal?: AbortSignal) =>
    get<{ formats: readonly FormatDetail[]; by_shelf: readonly ShelfFormat[] }>(
      url("/api/formats", { root, shelf }), signal),

  trash: (signal?: AbortSignal) =>
    get<{ total: number; items: readonly TrashRow[] }>(url("/api/trash"), signal),

  reading: (limit = 120, signal?: AbortSignal) =>
    get<{ books: readonly ReadingRow[] }>(url("/api/reading", { limit }), signal),

  scan: () => post<{
    books: number; new: number; updated: number; returned: number;
    vanished: number; seconds: number;
  }>("/api/scan"),

  saveProgress: (body: {
    book_id: number; locator: string | null; position: number;
    percent: number; finished: boolean;
  }) => post<{ ok: boolean }>("/api/progress", body),

  clearProgress: (bookId: number) =>
    post<{ ok: boolean }>("/api/progress", { book_id: bookId, clear: true }),

  /** `file` is the whole decision: "keep" leaves it on disk, "trash" moves
      it into its root's _trash folder, from where it can be restored. */
  deleteBook: (bookId: number, file: "keep" | "trash") =>
    post<{ ok: boolean; reason?: string; trash_id?: number; file_state?: string }>(
      "/api/books/delete", { book_id: bookId, file }),

  restore: (trashId: number) =>
    post<{ ok: boolean; reason?: string; title?: string; present?: number }>(
      "/api/trash/restore", { trash_id: trashId }),

  emptyTrash: (trashId?: number) =>
    post<{ ok: boolean; entries: number; files_deleted: number;
           files_kept: number; failed: number }>(
      "/api/trash/empty", trashId === undefined ? {} : { trash_id: trashId }),

  open: (path: string) => post<{ ok: boolean }>("/api/open", { path }),
  reveal: (path: string) => post<{ ok: boolean }>("/api/reveal", { path }),
};
