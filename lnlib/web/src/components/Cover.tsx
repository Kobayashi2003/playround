/* One cover image, built on demand and never twice.

   A card asks for its thumbnail only while it is on screen; `wanted` is what
   the queue re-checks just before it starts work, so tiles scrolled past
   during a fast flick cost nothing at all. */

import { useEffect, useRef, useState } from 'react';
import { coverUrl } from '../lib/mount';
import * as Thumbs from '../lib/thumbs';

interface CoverProps {
  readonly bookId: number;
  /** What the index already knows about this cover, or null if it has never
      been looked for. Only a cover already established not to exist is skipped:
      a 404 per card is the most expensive kind of nothing, but a book whose
      cover has simply not been extracted yet is worth asking for -- the server
      pulls it out of the file on the first request. */
  readonly state: string | null;
  readonly alt?: string;
  /** False while a recycled card is off screen, so its request can be dropped. */
  readonly visible?: boolean;
}

const hopeless = (state: string | null) => state === 'none' || state === 'error';

export function Cover({ bookId, state, alt = '', visible = true }: CoverProps) {
  const [src, setSrc] = useState<string | null>(() =>
    hopeless(state) ? null : Thumbs.peek(bookId),
  );
  const [failed, setFailed] = useState(hopeless(state));
  const alive = useRef(visible);
  alive.current = visible;

  useEffect(() => {
    if (hopeless(state)) {
      setSrc(null);
      setFailed(true);
      return;
    }

    const ready = Thumbs.peek(bookId);
    if (ready) {
      setSrc(ready);
      setFailed(false);
      return;
    }
    if (!Thumbs.supported()) {
      setSrc(coverUrl(bookId));
      setFailed(false);
      return;
    }

    // Nothing is drawn while it is being built: a placeholder that flashes and
    // is replaced a moment later reads as an error the first time you see it.
    setSrc(null);
    setFailed(false);
    let current = true;
    Thumbs.get(bookId, () => current && alive.current)
      .then(url => {
        if (current) {
          setSrc(url);
          setFailed(false);
        }
      })
      .catch((error: Error) => {
        if (current && error.message !== 'dropped') setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [bookId, state]);

  if (failed) return <div className="none">表紙なし</div>;
  if (!src) return null;
  return (
    <img src={src} alt={alt} decoding="async" loading="lazy" onError={() => setFailed(true)} />
  );
}
