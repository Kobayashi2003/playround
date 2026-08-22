/* Cover thumbnails, made and cached by the browser.

   The cover cache on disk is the real thing: byte-for-byte copies of what was
   inside the epub, averaging ~1 MB and 2.4 megapixels, some of them 60 MB.
   The shelf draws them at 132 px. Handing the originals to the grid costs
   roughly 10 MB of decoded bitmap per tile, which is what made scrolling
   stutter no matter how few cards were in the DOM.

   There is no imaging library on the Python side and adding one would break
   the "standard library only" rule, so the downscaling happens here: fetch a
   cover once, let the browser decode it straight to thumbnail size, re-encode
   it as a small JPEG and keep it in IndexedDB. From then on a tile costs
   ~15 KB and a fraction of a megapixel.

   Everything degrades: no IndexedDB, no OffscreenCanvas, a cover that will not
   decode -- the grid falls back to /cover/<id> and simply stays as slow as it
   was before. */
"use strict";

const Thumbs = (() => {
  const DB_NAME = "lnlib-thumbs";
  const DB_VERSION = 1;
  const STORE = "thumbs";
  const WIDTH = 264;            // 132 px tile at 2x, enough for HiDPI
  const QUALITY = 0.82;
  const MAX_PARALLEL = 2;   // covers reach tens of MB; two at a time is plenty
  const MAX_URLS = 500;         // object URLs kept alive at once

  const GEN_KEY = "__generation";

  const urls = new Map();       // item id -> object URL (insertion ordered = LRU)
  const pending = new Map();    // item id -> Promise
  const failed = new Set();
  let queue = [];
  let running = 0;
  let dbPromise = null;
  let usable = true;

  /* --------------------------------------------------------------- store */
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); } catch { return resolve(null); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    });
    return dbPromise;
  }

  /* `scan` rebuilds the items table from scratch, so item ids are not stable
     across scans -- thumbnail 42 could become a different book entirely. The
     cache is therefore stamped with the scan it was built from and thrown away
     whenever that changes, including scans run from the command line. */
  let generation = null;
  let checked = null;

  function checkGeneration(gen) {
    if (gen == null) return Promise.resolve();
    if (generation === gen && checked) return checked;
    generation = gen;
    checked = (async () => {
      const db = await openDB();
      if (!db) return;
      const stored = await new Promise((resolve) => {
        try {
          const req = db.transaction(STORE, "readonly").objectStore(STORE).get(GEN_KEY);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(undefined);
        } catch { resolve(undefined); }
      });
      if (stored !== gen) {
        for (const url of urls.values()) URL.revokeObjectURL(url);
        urls.clear(); failed.clear();
        try {
          const tx = db.transaction(STORE, "readwrite");
          tx.objectStore(STORE).clear();
          tx.objectStore(STORE).put(gen, GEN_KEY);
        } catch { /* nothing cached is better than something wrong */ }
      }
    })();
    return checked;
  }

  async function idbGet(id) {
    await checked;
    const db = await openDB();
    if (!db) return null;
    return new Promise((resolve) => {
      let tx;
      try { tx = db.transaction(STORE, "readonly"); } catch { return resolve(null); }
      const req = tx.objectStore(STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  }

  async function idbPut(id, blob) {
    const db = await openDB();
    if (!db) return;
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(blob, id);
    } catch { /* quota or a closing database: the thumbnail is still usable */ }
  }

  /* ---------------------------------------------------------------- make */
  async function shrink(blob) {
    // createImageBitmap decodes straight to the requested size, so the full
    // 2.4 MP bitmap never has to exist.
    let bmp = null;
    try {
      bmp = await createImageBitmap(blob, { resizeWidth: WIDTH, resizeQuality: "medium" });
    } catch {
      bmp = await createImageBitmap(blob);       // older engines ignore options
    }
    const scale = Math.min(1, WIDTH / bmp.width);
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));

    let canvas, ctx;
    if (typeof OffscreenCanvas === "function") {
      canvas = new OffscreenCanvas(w, h);
      ctx = canvas.getContext("2d");
    } else {
      canvas = document.createElement("canvas");
      canvas.width = w; canvas.height = h;
      ctx = canvas.getContext("2d");
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close && bmp.close();

    if (canvas.convertToBlob) {
      return canvas.convertToBlob({ type: "image/jpeg", quality: QUALITY });
    }
    return new Promise((resolve, reject) => canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("toBlob failed"))),
      "image/jpeg", QUALITY));
  }

  function remember(id, blob) {
    const url = URL.createObjectURL(blob);
    urls.set(id, url);
    while (urls.size > MAX_URLS) {
      const oldest = urls.keys().next().value;
      URL.revokeObjectURL(urls.get(oldest));
      urls.delete(oldest);
    }
    return url;
  }

  async function fetchCover(id) {
    // Localhost still runs out of socket buffers when several 60 MB covers are
    // in flight, and that failure is transient -- one retry clears it.
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(MOUNT + "/cover/" + id);
        if (res.status === 404) throw new Error("no cover");
        if (!res.ok) throw new Error("cover " + res.status);
        return await res.blob();
      } catch (e) {
        if (attempt >= 1 || e.message === "no cover") throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  }

  async function build(id) {
    const cached = await idbGet(id);
    if (cached) return remember(id, cached);

    const original = await fetchCover(id);
    let small;
    try {
      small = await shrink(original);
    } catch {
      small = original;                  // undecodable: keep it whole, still works
    }
    if (small.size < original.size) idbPut(id, small);
    return remember(id, small);
  }

  /* --------------------------------------------------------------- queue */
  function pump() {
    while (running < MAX_PARALLEL && queue.length) {
      const job = queue.shift();
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

  /** A thumbnail URL for this cover, or null if it has to be built first. */
  function peek(id) {
    return urls.get(id) || null;
  }

  /** Resolves to an object URL for the thumbnail. `wanted` is re-checked just
      before work starts, so tiles scrolled past never cost anything. */
  function get(id, wanted) {
    const have = urls.get(id);
    if (have) return Promise.resolve(have);
    if (failed.has(id)) return Promise.reject(new Error("failed earlier"));
    if (pending.has(id)) return pending.get(id);

    const p = new Promise((resolve, reject) => {
      queue.push({ id, wanted, resolve, reject });
      pump();
    });
    // Only a cover that genuinely is not there is remembered as failed; a
    // network hiccup must not blank the tile for the rest of the session.
    p.catch((e) => { if (String(e.message) === "no cover") failed.add(id); });
    pending.set(id, p);
    return p;
  }

  /** Visible tiles should be built before ones that scrolled out of view. */
  function prioritise(idSet) {
    if (queue.length < 2) return;
    const hot = [], cold = [];
    for (const job of queue) (idSet.has(job.id) ? hot : cold).push(job);
    queue = hot.concat(cold);
  }

  function supported() {
    return usable && typeof createImageBitmap === "function"
           && typeof indexedDB !== "undefined";
  }

  async function clear() {
    for (const url of urls.values()) URL.revokeObjectURL(url);
    urls.clear(); failed.clear();
    const db = await openDB();
    if (!db) return;
    try { db.transaction(STORE, "readwrite").objectStore(STORE).clear(); } catch {}
  }

  async function stats() {
    const db = await openDB();
    if (!db) return { count: 0 };
    return new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, "readonly").objectStore(STORE).count();
        req.onsuccess = () => resolve({ count: req.result, live: urls.size });
        req.onerror = () => resolve({ count: 0, live: urls.size });
      } catch { resolve({ count: 0, live: urls.size }); }
    });
  }

  return { get, peek, prioritise, supported, clear, stats, checkGeneration, WIDTH };
})();
