import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
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
} from "@/lib/types";

export const Route = createFileRoute("/_authenticated/mass/$weekId/reports")({
  component: MassWeekReportsPage,
});

const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel" },
  { value: "pdf", label: "PDF" },
] as const;

/**
 * Reporting for one week, kept apart from the upload screen: pick who the
 * report is for, optionally one level, then read the tables on screen or take
 * the same numbers away as CSV, Excel or PDF.
 */
function MassWeekReportsPage() {
  const { weekId } = Route.useParams();
  const [participant, setParticipant] = useState<MassUploadParticipant>("student");
  const [level, setLevel] = useState("");
  const [groupBy, setGroupBy] = useState<MassReportGroupBy>("none");
  const [format, setFormat] = useState<(typeof FORMATS)[number]["value"]>("csv");

  const week = useQuery({
    queryKey: ["mass-week", weekId],
    queryFn: () => api.mass.week(weekId),
  });

  const levels = useQuery({
    queryKey: ["levels"],
    queryFn: api.levels,
    enabled: participant === "student",
  });

  const result = useQuery({
    queryKey: ["mass-result", weekId, participant, level],
    queryFn: () => api.mass.result(weekId, { participantType: participant, level: level || null }),
  });

  if (week.isError) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        {(week.error as Error).message}
      </p>
    );
  }

  const covered: MassUploadParticipant[] = !week.data
    ? ["student"]
    : week.data.participant_type === "both"
      ? ["student", "staff"]
      : week.data.participant_type === "staff"
        ? ["staff"]
        : ["student"];

  /**
   * The link that downloads one category of this week's report. The two lists
   * people actually take away -- present and absent -- each have their own
   * button; the rest are offered quietly beside them.
   */
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
      <Panel
        title={`Reports — ${week.data?.name ?? "…"}`}
        description="Read the tables on screen, or download the same numbers as CSV, Excel or PDF. Grouping applies to the downloaded file."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="report-participant">Who</Label>
            <Select
              value={participant}
              onValueChange={(value) => {
                const next = value === "staff" ? "staff" : "student";
                setParticipant(next);
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

          <Tabs defaultValue="present">
            <TabsList>
              <TabsTrigger value="present">Present ({result.data.presentList.length})</TabsTrigger>
              <TabsTrigger value="absent">Absent ({result.data.absentList.length})</TabsTrigger>
              <TabsTrigger value="out-of-scope">
                Out of scope ({result.data.outOfScopeList.length})
              </TabsTrigger>
              <TabsTrigger value="unmatched">
                Unmatched ({result.data.unmatchedList.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="present" className="mt-4">
              {result.data.presentList.length === 0 ? (
                <EmptyState title="Nobody marked present yet" />
              ) : (
                <DataTable
                  head={["Name", "Number", "Level", "Department", "Day", "Scans", "First", "Last"]}
                >
                  {result.data.presentList.map((row) => (
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
                        <span className="tabular-nums">{row.scan_count}</span>,
                        formatDateTime(row.first_scan_at),
                        formatDateTime(row.last_scan_at),
                      ]}
                    />
                  ))}
                </DataTable>
              )}
            </TabsContent>

            <TabsContent value="absent" className="mt-4">
              {result.data.absentList.length === 0 ? (
                <EmptyState title="Nobody is absent" />
              ) : (
                <DataTable head={["Name", "Number", "Level", "Department", "Day"]}>
                  {result.data.absentList.map((row) => (
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
              {result.data.outOfScopeList.length === 0 ? (
                <EmptyState title="No scans fell outside the expected population" />
              ) : (
                <DataTable head={["Name", "Number", "Level", "Department", "Scans"]}>
                  {result.data.outOfScopeList.map((row) => (
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
              {result.data.unmatchedList.length === 0 ? (
                <EmptyState title="Every scan matched a master record" />
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
                  {result.data.unmatchedList.map((row) => (
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
