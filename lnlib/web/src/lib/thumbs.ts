/* Cover thumbnails, made and cached by the browser.

   The cover cache on disk is the real thing: byte-for-byte copies of what was
   inside the epub, averaging ~1 MB and 2.4 megapixels, some of them 60 MB.
   The shelf draws them at 132 px. Handing the originals to the grid costs
   roughly 10 MB of decoded bitmap per tile, which is what made scrolling
   stutter no matter how few cards were in the DOM.

   There is no imaging library on the Python side and adding one would break
   the "standard library only" rule there, so the downscaling happens here:
   fetch a cover once, let the browser decode it straight to thumbnail size,
   re-encode it as a small JPEG and keep it in IndexedDB. From then on a tile
   costs ~15 KB and a fraction of a megapixel.

   Everything degrades: no IndexedDB, no createImageBitmap, a cover that will
   not decode -- the grid falls back to /cover/<id> and is simply as slow as it
   would have been anyway. */

import { coverUrl } from "./mount";

const DB_NAME = "lnlib-thumbs";
const DB_VERSION = 1;
const STORE = "thumbs";
const WIDTH = 264;            // 132 px tile at 2x, enough for HiDPI
const QUALITY = 0.82;
const MAX_PARALLEL = 2;       // covers reach tens of MB; two at a time is plenty
const MAX_URLS = 600;         // object URLs kept alive at once
const GEN_KEY = "__generation";

interface Job {
  readonly id: number;
  readonly wanted?: () => boolean;
  readonly resolve: (url: string) => void;
  readonly reject: (error: Error) => void;
}

const urls = new Map<number, string>();   // insertion order doubles as LRU
const pending = new Map<number, Promise<string>>();
const failed = new Set<number>();
let queue: Job[] = [];
let running = 0;
let dbPromise: Promise<IDBDatabase | null> | null = null;

/* --------------------------------------------------------------- store */
function openDB(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/* Thumbnails are keyed by book id, so the cache is only valid for as long as
   those ids mean what they meant. A scan updates rows in place and ids survive
   it, so the stamp is the *incarnation* of the index -- bumped when the table
   is built again from nothing, or when a root is dropped -- and not the time
   of the last scan. */
let generation: number | null = null;
let checked: Promise<void> | null = null;

export function checkGeneration(gen: number | null | undefined): Promise<void> {
  if (gen == null) return Promise.resolve();
  if (generation === gen && checked) return checked;
  generation = gen;
  checked = (async () => {
    const db = await openDB();
    if (!db) return;
    const stored = await new Promise<unknown>((resolve) => {
      try {
        const request = db.transaction(STORE, "readonly").objectStore(STORE).get(GEN_KEY);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(undefined);
      } catch { resolve(undefined); }
    });
    if (stored !== gen) {
      for (const objectUrl of urls.values()) URL.revokeObjectURL(objectUrl);
      urls.clear();
      failed.clear();
      try {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).clear();
        tx.objectStore(STORE).put(gen, GEN_KEY);
      } catch { /* nothing cached is better than something wrong */ }
    }
  })();
  return checked;
}

async function idbGet(id: number): Promise<Blob | null> {
  await checked;
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(STORE, "readonly"); } catch { return resolve(null); }
    const request = tx.objectStore(STORE).get(id);
    request.onsuccess = () => resolve((request.result as Blob) || null);
    request.onerror = () => resolve(null);
  });
}

async function idbPut(id: number, blob: Blob): Promise<void> {
  const db = await openDB();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(blob, id);
  } catch { /* quota or a closing database: the thumbnail is still usable */ }
}

/* ---------------------------------------------------------------- make */
async function shrink(blob: Blob): Promise<Blob> {
  // createImageBitmap decodes straight to the requested size, so the full
  // 2.4 MP bitmap never has to exist.
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob, {
      resizeWidth: WIDTH, resizeQuality: "medium",
    });
  } catch {
    bitmap = await createImageBitmap(blob);       // older engines ignore options
  }
  const scale = Math.min(1, WIDTH / bitmap.width);
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    return canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
  }

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no 2d context");
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob(
    (out) => (out ? resolve(out) : reject(new Error("toBlob failed"))),
    "image/jpeg", QUALITY));
}

function remember(id: number, blob: Blob): string {
  const objectUrl = URL.createObjectURL(blob);
  urls.set(id, objectUrl);
  while (urls.size > MAX_URLS) {
    const oldest = urls.keys().next().value;
    if (oldest === undefined) break;
    URL.revokeObjectURL(urls.get(oldest)!);
    urls.delete(oldest);
  }
  return objectUrl;
}

async function fetchCover(id: number): Promise<Blob> {
  // Localhost still runs out of socket buffers when several 60 MB covers are
  // in flight, and that failure is transient -- one retry clears it.
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(coverUrl(id));
      if (res.status === 404) throw new Error("no cover");
      if (!res.ok) throw new Error(`cover ${res.status}`);
      return await res.blob();
    } catch (e) {
      if (attempt >= 1 || (e as Error).message === "no cover") throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function build(id: number): Promise<string> {
  const cached = await idbGet(id);
  if (cached) return remember(id, cached);

  const original = await fetchCover(id);
  let small: Blob;
  try {
    small = await shrink(original);
  } catch {
    small = original;                  // undecodable: keep it whole, still works
  }
  if (small.size < original.size) void idbPut(id, small);
  return remember(id, small);
}

/* --------------------------------------------------------------- queue */
function pump(): void {
  while (running < MAX_PARALLEL && queue.length) {
    const job = queue.shift()!;
    if (job.wanted && !job.wanted()) {
      pending.delete(job.id);        // let it be asked for again on the way back
      job.reject(new Error("dropped"));
      continue;
    }
    running++;
    build(job.id).then(job.resolve, job.reject).finally(() => {
      running--;
      pending.delete(job.id);
      pump();
    });
  }
}

/** A thumbnail URL for this cover if one is already built, else null. */
export const peek = (id: number): string | null => urls.get(id) ?? null;

/** Resolves to an object URL for the thumbnail. `wanted` is re-checked just
    before work starts, so tiles scrolled past never cost anything. */
export function get(id: number, wanted?: () => boolean): Promise<string> {
  const have = urls.get(id);
  if (have) return Promise.resolve(have);
  if (failed.has(id)) return Promise.reject(new Error("failed earlier"));
  const already = pending.get(id);
  if (already) return already;

  let settle!: { resolve: (url: string) => void; reject: (e: Error) => void };
  const promise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // Only a cover that genuinely is not there is remembered as failed; a
  // network hiccup must not blank the tile for the rest of the session.
  promise.catch((e: Error) => { if (e.message === "no cover") failed.add(id); });
  // Recorded before the queue is pumped, never after: `pump` can find the job
  // already unwanted and clear its entry on the spot, and an entry written
  // after that would leave a rejected promise under this id for good.
  pending.set(id, promise);
  queue.push({ id, wanted, resolve: settle.resolve, reject: settle.reject });
  pump();
  return promise;
}

/** Visible tiles should be built before ones that scrolled out of view. */
export function prioritise(hot: ReadonlySet<number>): void {
  if (queue.length < 2) return;
  const near: Job[] = [];
  const far: Job[] = [];
  for (const job of queue) (hot.has(job.id) ? near : far).push(job);
  queue = near.concat(far);
}

export const supported = () =>
  typeof createImageBitmap === "function" && typeof indexedDB !== "undefined";

export async function clear(): Promise<void> {
  for (const objectUrl of urls.values()) URL.revokeObjectURL(objectUrl);
  urls.clear();
  failed.clear();
  const db = await openDB();
  if (!db) return;
  try {
    db.transaction(STORE, "readwrite").objectStore(STORE).clear();
  } catch { /* best effort */ }
}
