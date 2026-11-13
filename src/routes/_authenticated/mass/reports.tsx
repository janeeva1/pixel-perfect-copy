import { createFileRoute, Link } from "@tanstack/react-router";
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
import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import {
  MASS_REPORT_GROUP_OPTIONS,
  MASS_STATUS_LABELS,
  MASS_WEEKDAY_LABELS,
  type MassReportGroupBy,
  type MassWeek,
  type MassWeekParticipantType,
} from "@/lib/types";

export const Route = createFileRoute("/_authenticated/mass/reports")({
  component: MassReportsHubPage,
});

const PARTICIPANT_LABELS: Record<MassWeekParticipantType, string> = {
  students: "Students",
  staff: "Staff",
  both: "Students & staff",
};

const FORMATS = [
  { value: "csv", label: "CSV" },
  { value: "xlsx", label: "Excel" },
  { value: "pdf", label: "PDF" },
] as const;

type Format = (typeof FORMATS)[number]["value"];

/**
 * Every weekly Mass, with the report it can produce one click away.
 *
 * The point of this page is that the two lists people actually take away -- who
 * was present and who was absent -- are one button each, in the format they
 * asked for. The summary is still on each week's own report page, but it is
 * not what this page offers first.
 */
function MassReportsHubPage() {
  const [format, setFormat] = useState<Format>("csv");
  const [participant, setParticipant] = useState<"student" | "staff">("student");
  const [groupBy, setGroupBy] = useState<MassReportGroupBy>("none");

  const weeks = useQuery({
    queryKey: ["mass-weeks"],
    queryFn: api.mass.weeks,
  });

  return (
    <div className="space-y-6">
      <Panel
        title="Weekly Mass Reports"
        description="Every weekly Mass record. Download the list of those present or the list of those absent, in the format and grouping you choose."
      >
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label htmlFor="hub-participant">Who</Label>
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
              <SelectTrigger id="hub-participant" className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="student">Students</SelectItem>
                <SelectItem value="staff">Staff</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="hub-group">Group by</Label>
            <Select
              value={groupBy}
              onValueChange={(value) => setGroupBy(value as MassReportGroupBy)}
            >
              <SelectTrigger id="hub-group" className="w-44">
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
            <Label htmlFor="hub-format">Format</Label>
            <Select
              value={format}
              onValueChange={(value) =>
                setFormat(value === "xlsx" || value === "pdf" ? value : "csv")
              }
            >
              <SelectTrigger id="hub-format" className="w-28">
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
          </div>
        </div>
      </Panel>

      {weeks.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {(weeks.error as Error).message}
        </p>
      ) : null}
      {!weeks.data ? (
        <p className="text-sm text-muted-foreground">Loading weeks…</p>
      ) : weeks.data.weeks.length === 0 ? (
        <EmptyState title="No weekly Mass records yet">
          Create a week on the Weekly Mass page first.
        </EmptyState>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {weeks.data.weeks.map((week) => (
            <WeekReportCard
              key={week.id}
              week={week}
              format={format}
              participant={participant}
              groupBy={groupBy}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function WeekReportCard({
  week,
  format,
  participant,
  groupBy,
}: {
  week: MassWeek;
  format: Format;
  participant: "student" | "staff";
  groupBy: MassReportGroupBy;
}) {
  const covers = PARTICIPANT_LABELS[week.participant_type].toLowerCase();
  const applies = week.participant_type === "both" || week.participant_type === participant;

  const presentUrl = api.mass.reportUrl(week.id, {
    participantType: participant,
    level: null,
    category: "present",
    format,
    groupBy,
  });
  const absentUrl = api.mass.reportUrl(week.id, {
    participantType: participant,
    level: null,
    category: "absent",
    format,
    groupBy,
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 shadow-sm">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-medium">{week.name}</p>
          <p className="text-xs text-muted-foreground">
            {week.scope === "sunday"
              ? "Sunday Mass"
              : week.weekdays.map((day) => MASS_WEEKDAY_LABELS[day] ?? String(day)).join(", ")}
          </p>
        </div>
        <Badge variant="outline">{MASS_STATUS_LABELS[week.status]}</Badge>
      </div>

      <p className="mt-2 text-xs text-muted-foreground">Covers {covers}</p>

      {applies ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <a href={presentUrl} download>
            <Button variant="outline" size="sm">
              Present list ({format.toUpperCase()})
            </Button>
          </a>
          <a href={absentUrl} download>
            <Button variant="outline" size="sm">
              Absent list ({format.toUpperCase()})
            </Button>
          </a>
        </div>
      ) : (
        <p className="mt-3 text-xs text-muted-foreground">
          This week covers {covers}, so it has no {participant} report.
        </p>
      )}

      <Link
        to="/mass/$weekId/reports"
        params={{ weekId: week.id }}
        className="mt-3 inline-block text-xs underline underline-offset-4"
      >
        Open the full report
      </Link>
    </div>
  );
}
