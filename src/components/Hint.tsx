import type { ReactNode } from "react";

/** A short, small-print explanation shown under a button, option or table. */
export function Hint({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`text-xs leading-snug text-muted-foreground ${className}`}>{children}</p>;
}

/** Small-print meaning of each column of the table above it. */
export function ColumnGuide({ items }: { items: Array<[string, string]> }) {
  return (
    <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
      {items.map(([name, meaning], index) => (
        <span key={name}>
          <span className="font-medium text-foreground/70">{name}</span>: {meaning}
          {index < items.length - 1 ? " · " : ""}
        </span>
      ))}
    </p>
  );
}
