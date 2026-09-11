/* A loading line that is held back.

   Almost everything the shelf asks for is either cached or a few milliseconds
   away. Drawing a spinner for those makes the interface flicker and look
   slower than it is, so the message waits: if the answer arrives first, as it
   usually does, nothing was ever shown. */

import type { ReactNode } from "react";
import { useDelayedFlag } from "../lib/hooks";

export function Delayed({ active, after = 180, children }: {
  readonly active: boolean;
  readonly after?: number;
  readonly children?: ReactNode;
}) {
  const shown = useDelayedFlag(active, after);
  if (!shown) return null;
  return <div className="empty loading">{children ?? "読み込み中…"}</div>;
}
