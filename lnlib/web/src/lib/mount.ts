/* Where this copy of the shelf is mounted.

   It runs at the origin root on its own and under a path prefix when a shared
   edge fronts it beside other apps. Assets are linked relatively so they
   resolve either way; the API, cover and book URLs are root-absolute, so they
   are built against the document's own directory, which the server guarantees
   by redirecting the bare prefix to the slashed form. */

export const MOUNT = new URL('.', document.baseURI).pathname.replace(/\/$/, '');

export function url(path: string, params?: Record<string, unknown>): string {
  const base = MOUNT + path;
  if (!params) return base;
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    qs.set(key, String(value));
  }
  const query = qs.toString();
  return query ? `${base}?${query}` : base;
}

/** A path inside a book, each segment encoded but the slashes left alone. */
export function bookFile(bookId: number, inner: string): string {
  const encoded = inner.split('/').map(encodeURIComponent).join('/');
  return `${MOUNT}/book/${bookId}/f/${encoded}`;
}

export const bookRaw = (bookId: number) => `${MOUNT}/book/${bookId}/raw`;
export const coverUrl = (bookId: number) => `${MOUNT}/cover/${bookId}`;
