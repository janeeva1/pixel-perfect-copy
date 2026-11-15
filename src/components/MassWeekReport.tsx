import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MatchReviewBanner } from "@/components/MatchReviewDialog";
import { ReportFilterBar } from "@/components/ReportFilters";
import {
  EMPTY_FILTER,
  passesFilter,
  shownOf,
  type FilterFields,
  type ReportFilterState,
} from "@/lib/report-filter";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataRow,
  DataTable,
  EmptyState,
  Panel,
  PercentBar,
  StatTile,
  formatDateTime,
} from "@/components/attendance-ui";
import { api } from "@/lib/api";
import {
  MASS_REPORT_GROUP_OPTIONS,
  MASS_WEEKDAY_LABELS,
  type MassReportGroupBy,
  type MassUploadParticipant,
  type MassWeekParticipantType,
} from "@/lib/types";

const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel" },
  { value: "pdf", label: "PDF" },
] as const;

/** Who a week covers, as the participants its uploads and reports can be for. */
function coveredBy(type: MassWeekParticipantType | undefined): MassUploadParticipant[] {
  if (type === "both") return ["student", "staff"];
  if (type === "staff") return ["staff"];
  return ["student"];
}

/**
 * One week's report: the same per-person result the upload screen decides
 * (present, absent, out of scope, unmatched), read on screen and downloaded as
 * CSV, Excel or PDF.
 *
 * Who it is for follows the week: a staff-only week shows staff, a
 * student-only week shows students, and a week with both asks which one first
 * (and switches to whichever group was just uploaded, when `uploadedFor` says).
 */
export function MassWeekReport({
  weekId,
  title,
  uploadedFor = null,
}: {
  weekId: string;
  title?: string;
  /** The group of the latest upload on this page, if any: shown straight away. */
  uploadedFor?: MassUploadParticipant | null;
}) {
  const [chosen, setChosen] = useState<MassUploadParticipant | null>(null);
  const [level, setLevel] = useState("");
  const [groupBy, setGroupBy] = useState<MassReportGroupBy>("none");
  const [format, setFormat] = useState<(typeof FORMATS)[number]["value"]>("csv");
  const [filter, setFilter] = useState<ReportFilterState>(EMPTY_FILTER);

  const week = useQuery({
    queryKey: ["mass-week", weekId],
    queryFn: () => api.mass.week(weekId),
  });
  const covered = coveredBy(week.data?.participant_type);
  // One group: that group, always. Both: the one the user picked, or the one
  // just uploaded; until then, nothing is guessed.
  useEffect(() => {
    if (uploadedFor) setChosen(uploadedFor);
  }, [uploadedFor]);
  const participant: MassUploadParticipant | null =
    covered.length === 1 ? covered[0]! : chosen && covered.includes(chosen) ? chosen : null;

  const levels = useQuery({
    queryKey: ["levels"],
    queryFn: api.levels,
    enabled: participant === "student",
  });

  const result = useQuery({
    queryKey: ["mass-result", weekId, participant, level],
    queryFn: () =>
      api.mass.result(weekId, { participantType: participant ?? "student", level: level || null }),
    enabled: week.data !== undefined && participant !== null,
  });

  if (week.isError) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        {(week.error as Error).message}
      </p>
    );
  }

  if (!week.data) return <p className="text-sm text-muted-foreground">Loading the report…</p>;

  const heading = title ?? `Report — ${week.data.name}`;
  if (participant === null) {
    return (
      <Panel
        title={heading}
        description="This week has both students and staff. Which report do you want to see?"
      >
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => setChosen("student")}>Students report</Button>
          <Button onClick={() => setChosen("staff")}>Staff report</Button>
        </div>
        <div className="mt-4 space-y-3">
          {covered.map((group) => (
            <GroupReviewBanner key={group} weekId={weekId} participant={group} />
          ))}
        </div>
      </Panel>
    );
  }

  /**
   * The link that downloads one category of this week's report. The two lists
   * people actually take away -- present and absent -- each have their own
   * button; the rest are offered quietly beside them.
   */
  // Reports wait until every uncertain match is confirmed (the server refuses too).
  const blocked = !result.data || result.data.pending_review + result.data.look_alikes > 0;

  const data = result.data;
  const expectedFields = (row: {
    full_name: string | null;
    person_no: string | null;
    department: string | null;
    day_of_week: number | null;
    level: string | null;
  }): FilterFields => ({
    name: row.full_name,
    number: row.person_no,
    department: row.department,
    day: row.day_of_week,
    level: row.level,
  });
  const presentFields = (data?.presentList ?? []).map(expectedFields);
  const absentFields = (data?.absentList ?? []).map(expectedFields);
  const outFields = (data?.outOfScopeList ?? []).map((row): FilterFields => ({
    name: row.full_name,
    number: row.person_no,
    department: row.department,
    level: row.level,
  }));
  const presentRows = (data?.presentList ?? []).filter((_, index) =>
    passesFilter(filter, presentFields[index]!),
  );
  const absentRows = (data?.absentList ?? []).filter((_, index) =>
    passesFilter(filter, absentFields[index]!),
  );
  const outRows = (data?.outOfScopeList ?? []).filter((_, index) =>
    passesFilter(filter, outFields[index]!),
  );
  // Unmatched scans have only what the machine printed: found by text alone.
  const unmatchedRows = (data?.unmatchedList ?? []).filter((row) =>
    passesFilter(
      { ...filter, department: "", day: "", level: "" },
      { name: row.scanned_name, number: row.scan_number },
    ),
  );

  const reportUrl = (which: "present" | "absent" | "out_of_scope" | "unmatched" | "summary") =>
    api.mass.reportUrl(weekId, {
      participantType: participant,
      level: level || null,
      category: which,
      format,
      groupBy,
    });

  return (
    <div className="space-y-6">
      {result.data ? (
        <MatchReviewBanner
          context={{ type: "mass", weekId, participantType: participant }}
          pendingScans={result.data.pending_review}
          lookAlikes={result.data.look_alikes}
        />
      ) : null}
      <Panel
        title={`${heading} · ${participant === "staff" ? "Staff" : "Students"}`}
        description="The same results as the upload above, per person. Read the tables here, or download them as CSV, Excel or PDF. Grouping applies to the downloaded file."
      >
        <div className="flex flex-wrap items-end gap-3">
          {covered.length > 1 ? (
            <div className="space-y-1">
              <Label htmlFor="report-participant">Who</Label>
              <Select
                value={participant}
                onValueChange={(value) => {
                  const next = value === "staff" ? "staff" : "student";
                  setChosen(next);
                  setLevel("");
                  if (next === "staff" && (groupBy === "level" || groupBy === "category")) {
                    setGroupBy("none");
                  }
                }}
              >
                <SelectTrigger id="report-participant" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {covered.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option === "student" ? "Students" : "Staff"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          {participant === "student" ? (
            <div className="space-y-1">
              <Label htmlFor="report-level">Level</Label>
              <Select
                value={level === "" ? "all" : level}
                onValueChange={(value) => setLevel(value === "all" ? "" : value)}
              >
                <SelectTrigger id="report-level" className="w-32">
                  <SelectValue placeholder="All levels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All levels</SelectItem>
                  {(levels.data ?? []).map((value) => (
                    <SelectItem key={value} value={value}>
                      Level {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}

          <div className="space-y-1">
            <Label htmlFor="report-group">Group by</Label>
            <Select
              value={groupBy}
              onValueChange={(value) => setGroupBy(value as MassReportGroupBy)}
            >
              <SelectTrigger id="report-group" className="w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MASS_REPORT_GROUP_OPTIONS[participant].map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1">
            <Label htmlFor="report-format">Download as</Label>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                value={format}
                onValueChange={(value) =>
                  setFormat(value === "xlsx" || value === "pdf" ? value : "csv")
                }
              >
                <SelectTrigger id="report-format" className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {FORMATS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!result.data ? (
                <p className="text-sm text-muted-foreground">Loading…</p>
              ) : blocked ? (
                <p className="text-sm text-amber-800">
                  Downloads are available once the matches above are confirmed.
                </p>
              ) : (
                <>
                  <a href={reportUrl("present")} download>
                    <Button variant="outline">Download Present list</Button>
                  </a>
                  <a href={reportUrl("absent")} download>
                    <Button variant="outline">Download Absent list</Button>
                  </a>
                  <a href={reportUrl("out_of_scope")} download>
                    <Button variant="ghost">Out of scope</Button>
                  </a>
                  <a href={reportUrl("unmatched")} download>
                    <Button variant="ghost">Unmatched</Button>
                  </a>
                  <a href={reportUrl("summary")} download>
                    <Button variant="ghost">Summary</Button>
                  </a>
                </>
              )}
            </div>
          </div>
        </div>
      </Panel>

      {result.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {(result.error as Error).message}
        </p>
      ) : null}
      {!result.data ? (
        <p className="text-sm text-muted-foreground">Loading the report…</p>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
            <StatTile label="Expected" value={result.data.expected} />
            <StatTile label="Present" value={result.data.present} tone="good" />
            <StatTile
              label="Absent"
              value={result.data.absent}
              tone={result.data.absent > 0 ? "bad" : "good"}
            />
            <StatTile
              label="Out of scope"
              value={result.data.out_of_scope}
              tone={result.data.out_of_scope > 0 ? "warn" : "default"}
            />
            <StatTile
              label="Unmatched"
              value={result.data.unmatched}
              tone={result.data.unmatched > 0 ? "warn" : "default"}
            />
          </div>
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <PercentBar value={result.data.percent} />
            <span>
              {result.data.percent === null
                ? "Nobody was expected, so there is no percentage."
                : "Present as a percentage of expected"}
            </span>
          </div>

          <ReportFilterBar
            state={filter}
            onChange={setFilter}
            rows={[...presentFields, ...absentFields, ...outFields]}
            placeholder="Search by name, staff/matric number or department"
          />

          <Tabs defaultValue="present">
            <TabsList>
              <TabsTrigger value="present">
                Present ({shownOf(presentRows.length, result.data.presentList.length)})
              </TabsTrigger>
              <TabsTrigger value="absent">
                Absent ({shownOf(absentRows.length, result.data.absentList.length)})
              </TabsTrigger>
              <TabsTrigger value="out-of-scope">
                Out of scope ({shownOf(outRows.length, result.data.outOfScopeList.length)})
              </TabsTrigger>
              <TabsTrigger value="unmatched">
                Unmatched ({shownOf(unmatchedRows.length, result.data.unmatchedList.length)})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="present" className="mt-4">
              {presentRows.length === 0 ? (
                <EmptyState
                  title={
                    result.data.presentList.length === 0
                      ? "Nobody marked present yet"
                      : "Nobody here matches the search"
                  }
                />
              ) : (
                <DataTable
                  head={["Name", "Number", "Level", "Department", "Day", "Scans", "First", "Last"]}
                >
                  {presentRows.map((row) => (
                    <DataRow
                      key={row.person_id}
                      cells={[
                        row.full_name,
                        <span className="font-mono text-xs">{row.person_no ?? "—"}</span>,
                        row.level ? `Level ${row.level}` : "—",
                        row.department ?? "—",
                        row.day_of_week === null
                          ? "—"
                          : (MASS_WEEKDAY_LABELS[row.day_of_week] ?? String(row.day_of_week)),
                        row.always_present ? (
                          <span className="text-xs text-emerald-700">Always present</span>
                        ) : (
                          <span className="tabular-nums">{row.scan_count}</span>
                        ),
                        formatDateTime(row.first_scan_at || null),
                        formatDateTime(row.last_scan_at || null),
                      ]}
                    />
                  ))}
                </DataTable>
              )}
            </TabsContent>

            <TabsContent value="absent" className="mt-4">
              {absentRows.length === 0 ? (
                <EmptyState
                  title={
                    result.data.absentList.length === 0
                      ? "Nobody is absent"
                      : "Nobody here matches the search"
                  }
                />
              ) : (
                <DataTable head={["Name", "Number", "Level", "Department", "Day"]}>
                  {absentRows.map((row) => (
                    <DataRow
                      key={row.person_id}
                      cells={[
                        row.full_name,
                        <span className="font-mono text-xs">{row.person_no ?? "—"}</span>,
                        row.level ? `Level ${row.level}` : "—",
                        row.department ?? "—",
                        row.day_of_week === null
                          ? "—"
                          : (MASS_WEEKDAY_LABELS[row.day_of_week] ?? String(row.day_of_week)),
                      ]}
                    />
                  ))}
                </DataTable>
              )}
            </TabsContent>

            <TabsContent value="out-of-scope" className="mt-4">
              {outRows.length === 0 ? (
                <EmptyState
                  title={
                    result.data.outOfScopeList.length === 0
                      ? "No scans fell outside the expected population"
                      : "Nobody here matches the search"
                  }
                />
              ) : (
                <DataTable head={["Name", "Number", "Level", "Department", "Scans"]}>
                  {outRows.map((row) => (
                    <DataRow
                      key={row.person_id}
                      cells={[
                        row.full_name,
                        <span className="font-mono text-xs">{row.person_no ?? "—"}</span>,
                        row.level ? `Level ${row.level}` : "—",
                        row.department ?? "—",
                        <span className="tabular-nums">{row.scan_count}</span>,
                      ]}
                    />
                  ))}
                </DataTable>
              )}
            </TabsContent>

            <TabsContent value="unmatched" className="mt-4">
              {unmatchedRows.length === 0 ? (
                <EmptyState
                  title={
                    result.data.unmatchedList.length === 0
                      ? "Every scan matched a master record"
                      : "No scan here matches the search"
                  }
                />
              ) : (
                <DataTable
                  head={[
                    "Scan ID",
                    "Number on the machine",
                    "Name on the machine",
                    "Scans",
                    "First",
                    "Last",
                  ]}
                >
                  {unmatchedRows.map((row) => (
                    <DataRow
                      key={row.scan_id}
                      cells={[
                        <span className="font-mono text-xs text-muted-foreground">
                          {row.scan_id.slice(0, 8)}…
                        </span>,
                        <span className="font-mono text-xs">{row.scan_number ?? "—"}</span>,
                        row.scanned_name ?? "—",
                        <span className="tabular-nums">{row.scan_count}</span>,
                        formatDateTime(row.first_scan_at),
                        formatDateTime(row.last_scan_at),
                      ]}
                    />
                  ))}
                </DataTable>
              )}
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}

/** A group's "confirm before reporting" banner, before a report is chosen. */
function GroupReviewBanner({
  weekId,
  participant,
}: {
  weekId: string;
  participant: MassUploadParticipant;
}) {
  const result = useQuery({
    queryKey: ["mass-result", weekId, participant, ""],
    queryFn: () => api.mass.result(weekId, { participantType: participant, level: null }),
  });
  if (!result.data) return null;
  return (
    <MatchReviewBanner
      context={{ type: "mass", weekId, participantType: participant }}
      pendingScans={result.data.pending_review}
      lookAlikes={result.data.look_alikes}
    />
  );
}
