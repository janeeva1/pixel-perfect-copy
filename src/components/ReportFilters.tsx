import { Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { MASS_WEEKDAY_LABELS } from "@/lib/types";
import {
  EMPTY_FILTER,
  filterOptions,
  type FilterFields,
  type ReportFilterState,
} from "@/lib/report-filter";

/**
 * Search and filters for a report's tables: one bar above the tabs, applied to
 * every list (present, absent, out of scope, unmatched), so switching tabs keeps
 * the same search. Only the filters the data has are shown: a department/unit
 * list when rows carry a department, weekdays when they carry a Mass day,
 * levels when they carry a level.
 */

export function ReportFilterBar({
  state,
  onChange,
  rows,
  placeholder = "Search by name or number",
  departmentLabel = "Department / unit",
}: {
  state: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
  /** Every row of every list, to build the drop-downs from. */
  rows: FilterFields[];
  placeholder?: string;
  departmentLabel?: string;
}) {
  const options = filterOptions(rows);
  const active =
    state.text !== "" || state.department !== "" || state.day !== "" || state.level !== "";
  const set = (patch: Partial<ReportFilterState>) => onChange({ ...state, ...patch });

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-card p-3">
      <div className="relative min-w-56 flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          className="pl-8"
          placeholder={placeholder}
          value={state.text}
          onChange={(event) => set({ text: event.target.value })}
          aria-label="Search"
        />
      </div>
      {options.departments.length > 0 ? (
        <Select
          value={state.department || "all"}
          onValueChange={(value) => set({ department: value === "all" ? "" : value })}
        >
          <SelectTrigger className="w-56" aria-label={departmentLabel}>
            <SelectValue placeholder={departmentLabel} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All {departmentLabel.toLowerCase()}s</SelectItem>
            {options.departments.map((department) => (
              <SelectItem key={department} value={department}>
                {department}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {options.days.length > 0 ? (
        <Select
          value={state.day || "all"}
          onValueChange={(value) => set({ day: value === "all" ? "" : value })}
        >
          <SelectTrigger className="w-40" aria-label="Weekday">
            <SelectValue placeholder="Weekday" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All weekdays</SelectItem>
            {options.days.map((day) => (
              <SelectItem key={day} value={String(day)}>
                {MASS_WEEKDAY_LABELS[day] ?? String(day)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {options.levels.length > 0 ? (
        <Select
          value={state.level || "all"}
          onValueChange={(value) => set({ level: value === "all" ? "" : value })}
        >
          <SelectTrigger className="w-36" aria-label="Level">
            <SelectValue placeholder="Level" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            {options.levels.map((level) => (
              <SelectItem key={level} value={level}>
                Level {level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {active ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_FILTER)}>
          <X className="mr-1 h-4 w-4" /> Clear
        </Button>
      ) : null}
    </div>
  );
}
