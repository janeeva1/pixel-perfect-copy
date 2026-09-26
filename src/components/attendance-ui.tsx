import type { ReactNode } from "react";

/** Small shared building blocks so the attendance pages stay readable. */
export function Panel({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="panel p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  icon,
}: {
  label: string;
  value: number | string | null | undefined;
  hint?: string;
  tone?: "default" | "good" | "warn" | "bad";
  icon?: React.ReactNode;
}) {
  const tones = {
    default: "text-foreground",
    good: "text-emerald-600 dark:text-emerald-400",
    warn: "text-amber-600 dark:text-amber-400",
    bad: "text-rose-600 dark:text-rose-400",
  } as const;

  return (
    <div className="panel p-4 flex items-center gap-3">
      {icon ? <span className="shrink-0">{icon}</span> : null}
      <div>
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className={`mt-1 font-display text-2xl font-semibold ${tones[tone]}`}>
          {value === null || value === undefined ? "-" : value}
        </p>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  );
}

export function PercentBar({ value }: { value: number | null }) {
  const width = value === null ? 0 : Math.max(0, Math.min(value, 100));
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-muted">
        <div
          className={`h-full rounded-full ${width >= 75 ? "bg-emerald-500" : width >= 50 ? "bg-amber-500" : "bg-rose-500"}`}
          style={{ width: `${width}%` }}
        />
      </div>
      <span className="w-12 text-right text-xs tabular-nums text-muted-foreground">
        {value === null ? "—" : `${value}%`}
      </span>
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border p-6 text-center">
      <p className="text-sm font-medium">{title}</p>
      {children ? <p className="mt-1 text-sm text-muted-foreground">{children}</p> : null}
    </div>
  );
}

export function DataTable({
  head,
  children,
  sortable = [],
  sortBy,
  sortDir,
  onSort,
  page,
  pageSize,
  total,
  onPageChange,
  onPageSizeChange,
}: {
  head: string[];
  children: ReactNode;
  /** Column keys (matching head labels) that can be sorted. */
  sortable?: string[];
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
  onSort?: (column: string) => void;
  /** Current page (1-indexed) for pagination. */
  page?: number | undefined;
  /** Rows per page. */
  pageSize?: number | undefined;
  /** Total number of rows (for page count). */
  total?: number | undefined;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const isSortable = (label: string) => sortable.includes(label);
  const totalPages = total && pageSize ? Math.ceil(total / pageSize) : 1;

  return (
    <div className="space-y-4">
      <div className="max-h-[32rem] overflow-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr>
              {head.map((label) => (
                <th
                  key={label}
                  className={`border-b border-border px-3 py-2 text-left font-medium ${isSortable(label) ? "cursor-pointer select-none hover:bg-muted" : ""}`}
                  onClick={() => isSortable(label) && onSort?.(label)}
                >
                  <div className="flex items-center gap-1">
                    {label}
                    {isSortable(label) && sortBy === label && (
                      <span className="text-xs text-muted-foreground">
                        {sortDir === "asc" ? "▲" : "▼"}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>{children}</tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="text-xs text-muted-foreground">
            {page && pageSize && total
              ? `Showing ${Math.min((page - 1) * pageSize + 1, total)}–${Math.min(page * pageSize, total)} of ${total.toLocaleString()}`
              : ""}
          </p>
          <div className="flex items-center gap-2">
            <select
              className="h-8 px-2 text-sm border border-input rounded bg-background"
              value={pageSize?.toString() ?? "20"}
              onChange={(e) => onPageSizeChange?.(Number(e.target.value))}
            >
              {[10, 20, 50, 100].map((size) => (
                <option key={size} value={size.toString()}>
                  {size} per page
                </option>
              ))}
            </select>
            <button
              className="h-8 px-3 text-sm border border-input rounded bg-background disabled:opacity-50"
              onClick={() => onPageChange?.((page ?? 1) - 1)}
              disabled={!page || page <= 1}
            >
              Previous
            </button>
            <span className="text-sm text-muted-foreground">
              Page {page ?? 1} of {totalPages}
            </span>
            <button
              className="h-8 px-3 text-sm border border-input rounded bg-background disabled:opacity-50"
              onClick={() => onPageChange?.((page ?? 1) + 1)}
              disabled={!page || (page ?? 1) >= totalPages}
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function DataRow({ cells }: { cells: ReactNode[] }) {
  return (
    <tr className="border-b border-border/60 last:border-0">
      {cells.map((cell, index) => (
        <td key={index} className="px-3 py-2 align-top">
          {cell}
        </td>
      ))}
    </tr>
  );
}

export function formatDateTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function categoryLabel(category: string | null | undefined): string {
  if (category === "undergraduate") return "Undergraduate";
  if (category === "postgraduate") return "Postgraduate";
  return "Uncategorised";
}
