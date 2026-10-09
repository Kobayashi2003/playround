/* Where a book was left off, kept in two places at once.

   The reader's own session port is synchronous: it hands over a record and
   expects the answer immediately, which a server cannot give. So the browser
   keeps the authoritative copy in localStorage -- locator, preferences and
   marks, exactly as the reader wrote them -- and every save is *also* pushed to
   the shelf, throttled, so the 読書中 list and the progress badges know how far
   this book has been read.

   The two are seeded from each other on the way in: whichever of the local
   record and the server's row was written last is the one the reader opens on.
   That is what lets a book read in one browser be picked up in another. */

import { api } from '../lib/api';
import type { Progress } from '../lib/types';
import type { ReadingSessionRecord, ReadingSessionStorage } from '../epub-reader/core';

const NAMESPACE = 'lnlib:epub:';
const PUSH_EVERY_MS = 4000;

/** The shelf's own row, packed into the reader's record shape. */
function fromServer(progress: Progress | null): ReadingSessionRecord | null {
  if (!progress?.locator) return null;
  try {
    const parsed = JSON.parse(progress.locator) as { locator?: unknown };
    const record = parsed as ReadingSessionRecord;
    if (!record?.locator) return null;
    return record;
  } catch {
    // A locator written by the previous reader was a bare spine href. There is
    // nothing here that can address a position inside this engine's model, so
    // the book simply opens at the beginning rather than somewhere wrong.
    return null;
  }
}

const readLocal = (key: string): ReadingSessionRecord | null => {
  try {
    const raw = localStorage.getItem(NAMESPACE + key);
    return raw ? (JSON.parse(raw) as ReadingSessionRecord) : null;
  } catch {
    return null;
  }
};

const writeLocal = (key: string, record: ReadingSessionRecord): void => {
  try {
    localStorage.setItem(NAMESPACE + key, JSON.stringify(record));
  } catch {
    /* quota, or private mode: the server copy still gets it */
  }
};

const newer = (a: ReadingSessionRecord | null, b: ReadingSessionRecord | null) => {
  if (!a) return b;
  if (!b) return a;
  return (a.updatedAt ?? '') >= (b.updatedAt ?? '') ? a : b;
};

export interface ShelfSession {
  readonly key: string;
  readonly storage: ReadingSessionStorage;
  /** The reader learns the spine length only after opening; progress needs it. */
  setSpineLength(length: number): void;
  /** Send whatever is outstanding now -- on leaving the reader, or unloading. */
  flush(): void;
  dispose(): void;
}

export function createShelfSession(bookId: number, seed: Progress | null): ShelfSession {
  const key = `book-${bookId}`;
  let spineLength = 0;
  let queued: ReadingSessionRecord | null = null;
  let timer = 0;
  let lastSent = 0;

  // Seeding is a write, not a read: the reader will call load() once and take
  // what it finds, so the fresher of the two records has to be in place first.
  const fresher = newer(readLocal(key), fromServer(seed));
  if (fresher) writeLocal(key, fresher);

  const push = () => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
    const record = queued;
    queued = null;
    if (!record) return;
    lastSent = Date.now();

    const index = record.locator?.spineIndex ?? 0;
    const within = record.locator?.locations?.progression ?? 0;
    const percent = spineLength > 0 ? Math.min(1, Math.max(0, (index + within) / spineLength)) : 0;

    void api
      .saveProgress({
        book_id: bookId,
        // The whole record goes over as the locator: nothing on the server side
        // reads it, and keeping it intact means a position can be restored
        // exactly rather than approximately.
        locator: JSON.stringify(record),
        position: within,
        percent,
        finished: percent >= 0.995,
      })
      .catch(() => {
        /* reading must not stop because a write failed */
      });
  };

  const schedule = () => {
    if (timer) return;
    const wait = Math.max(0, PUSH_EVERY_MS - (Date.now() - lastSent));
    timer = window.setTimeout(push, wait);
  };

  const storage: ReadingSessionStorage = {
    load: storageKey => readLocal(storageKey),
    save: (storageKey, record) => {
      writeLocal(storageKey, record);
      if (storageKey !== key) return; // another book's record: local only
      queued = record;
      schedule();
    },
    remove: storageKey => {
      try {
        localStorage.removeItem(NAMESPACE + storageKey);
      } catch {
        /* ignore */
      }
      if (storageKey === key) {
        queued = null;
        void api.clearProgress(bookId).catch(() => {});
      }
    },
  };

  /* No DOM listeners are registered here on purpose. A session is created per
     book opened, and anything this factory subscribed to would have to be
     unsubscribed by whoever happens to hold the object -- which React may
     construct more than once for a single mount. The component owns the
     lifetime instead and calls `flush` from an effect. */
  return {
    key,
    storage,
    setSpineLength: length => {
      spineLength = length;
    },
    flush: push,
    dispose: push,
  };
}
