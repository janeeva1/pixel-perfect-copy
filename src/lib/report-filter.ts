// Search and filters shared by every report table (see components/ReportFilters).

export type ReportFilterState = {
  text: string;
  department: string;
  day: string;
  level: string;
};

export const EMPTY_FILTER: ReportFilterState = { text: "", department: "", day: "", level: "" };

/** What one row offers to the search and filters. */
export type FilterFields = {
  name?: string | null;
  number?: string | null;
  department?: string | null;
  day?: number | null;
  level?: string | null;
  /** Anything else worth finding by text (e.g. the name the machine printed). */
  extra?: Array<string | null | undefined>;
};

function compact(value: string | null | undefined): string {
  return (value ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function words(value: string | null | undefined): string[] {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Whether a row passes. Text matches a name (every typed word somewhere in it,
 * any order), a number however it is spaced ("SA 534", "sa534" and "534" all
 * find SA534), a department or the extras.
 */
export function passesFilter(state: ReportFilterState, row: FilterFields): boolean {
  if (state.department && (row.department ?? "") !== state.department) return false;
  if (state.day && String(row.day ?? "") !== state.day) return false;
  if (state.level && (row.level ?? "") !== state.level) return false;
  const typed = state.text.trim();
  if (!typed) return true;

  const haystack = [row.name, row.department, ...(row.extra ?? [])].map((part) => words(part));
  const all = haystack.flat();
  const typedWords = words(typed);
  const byWords =
    typedWords.length > 0 && typedWords.every((word) => all.some((part) => part.includes(word)));
  if (byWords) return true;

  // A number is found whole, not as part of a longer one: "SA 39" finds SA39,
  // not SA393. Letters may be left out ("39" finds SA39 and SW39), and a full
  // matric number may be typed in any case or spacing.
  const number = compact(row.number);
  const query = compact(typed);
  if (number && query && number === query) return true;
  const digits = typed.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const numberDigits = (row.number ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
  const lettersTyped = /[A-Za-z]/.test(typed);
  if (digits === "" || numberDigits !== digits) {
    // A matric number ends in the machine number: "15336" finds VUG/PCS/25/15336.
    const tail = (row.number ?? "")
      .split("/")
      .pop()
      ?.replace(/\D/g, "")
      .replace(/^0+(?=\d)/, "");
    return !lettersTyped && digits !== "" && tail === digits;
  }
  // "SA39" must not find SW39: typed letters have to agree too.
  return !lettersTyped || compact(row.number).replace(/\d/g, "") === query.replace(/\d/g, "");
}

/** Choices for the drop-downs, from the rows themselves. */
export function filterOptions(rows: FilterFields[]): {
  departments: string[];
  days: number[];
  levels: string[];
} {
  const departments = new Set<string>();
  const days = new Set<number>();
  const levels = new Set<string>();
  for (const row of rows) {
    if (row.department) departments.add(row.department);
    if (row.day !== null && row.day !== undefined) days.add(row.day);
    if (row.level) levels.add(row.level);
  }
  return {
    departments: [...departments].sort((a, b) => a.localeCompare(b, "en")),
    days: [...days].sort((a, b) => a - b),
    levels: [...levels].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
  };
}

/** "12 of 509" when a filter hides rows, "509" otherwise. */
export function shownOf(shown: number, total: number): string {
  return shown === total ? String(total) : `${shown} of ${total}`;
}
