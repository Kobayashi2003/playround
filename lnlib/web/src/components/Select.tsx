/* A native select that does not look like one.

   The list itself is still the browser's, because a hand-built menu is a
   worse control than the real one on every platform that matters -- it just
   gets the shelf's border, spacing and a chevron drawn in CSS so the arrow
   takes its colour from the text rather than from the operating system. */

import type { ReactNode } from "react";

interface SelectProps {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}

export function Select({ value, onChange, label, children, className }: SelectProps) {
  return (
    <span className={`sel${className ? " " + className : ""}`}>
      <select
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
      >
        {children}
      </select>
      <i aria-hidden="true" />
    </span>
  );
}
