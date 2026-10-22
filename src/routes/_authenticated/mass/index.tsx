import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
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
  MASS_STATUS_LABELS,
  MASS_WEEKDAY_LABELS,
  type MassWeek,
  type MassWeekParticipantType,
  type MassWeekStatus,
} from "@/lib/types";
import { useRoles } from "@/lib/useAuth";

export const Route = createFileRoute("/_authenticated/mass/")({
  component: MassWeeksPage,
});

const PARTICIPANT_LABELS: Record<MassWeekParticipantType, string> = {
  students: "Students",
  staff: "Staff",
  both: "Students & staff",
};

const STATUS_VARIANT: Record<MassWeekStatus, "default" | "secondary" | "outline"> = {
  draft: "secondary",
  active: "default",
  completed: "outline",
  archived: "outline",
};

function MassWeeksPage() {
  const { canEdit } = useRoles();

  const weeks = useQuery({
    queryKey: ["mass-weeks"],
    queryFn: api.mass.weeks,
  });

  return (
    <div className="space-y-6">
      <Panel
        title="Weekly Community Mass"
        description="Every weekly record, newest first. Open a week to upload machine scans, change its status or reset it."
        actions={
          canEdit ? (
            <Link to="/mass/weekdays">
              <Button variant="outline">Department weekdays</Button>
            </Link>
          ) : null
        }
      >
        {weeks.isError ? (
          <p role="alert" className="text-sm text-rose-600">
            {(weeks.error as Error).message}
          </p>
        ) : null}
        {!weeks.data ? (
          <p className="text-sm text-muted-foreground">Loading weeks…</p>
        ) : weeks.data.weeks.length === 0 ? (
          <EmptyState title="No weekly Mass records yet">Create the first week below.</EmptyState>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {weeks.data.weeks.map((week) => (
              <Link
                key={week.id}
                to="/mass/$weekId"
                params={{ weekId: week.id }}
                className="group rounded-lg border border-border bg-card p-4 shadow-sm transition-colors hover:border-primary/50 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="font-medium group-hover:underline">{week.name}</p>
                  <Badge variant={STATUS_VARIANT[week.status]}>
                    {MASS_STATUS_LABELS[week.status]}
                  </Badge>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {PARTICIPANT_LABELS[week.participant_type]}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {week.scope === "sunday" ? (
                    <Badge variant="outline">Sunday</Badge>
                  ) : (
                    week.weekdays.map((day) => (
                      <Badge key={day} variant="outline">
                        {MASS_WEEKDAY_LABELS[day] ?? String(day)}
                      </Badge>
                    ))
                  )}
                </div>
                <p className="mt-3 text-xs text-muted-foreground group-hover:text-foreground">
                  Open this week
                </p>
              </Link>
            ))}
          </div>
        )}
      </Panel>

      {canEdit ? <CreateWeekPanel /> : null}
    </div>
  );
}

function CreateWeekPanel() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [notes, setNotes] = useState("");
  const [scope, setScope] = useState<"weekday" | "sunday">("weekday");
  const [participantType, setParticipantType] = useState<MassWeekParticipantType>("both");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);

  const create = useMutation({
    mutationFn: () =>
      api.mass.createWeek({
        name: name.trim(),
        notes: notes.trim() || null,
        scope,
        participantType,
        weekdays: scope === "weekday" ? weekdays : [],
      }),
    onSuccess: (week) => {
      toast.success("Week created");
      queryClient.invalidateQueries({ queryKey: ["mass-weeks"] });
      navigate({ to: "/mass/$weekId", params: { weekId: week.id } });
    },
    onError: (e) => toast.error(e.message),
  });

  function toggleDay(day: number) {
    setWeekdays((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort(),
    );
  }

  const blocked = !name.trim() || (scope === "weekday" && weekdays.length === 0);

  return (
    <Panel
      title="Create a weekly Mass record"
      description="A Sunday Mass covers every department and has no weekday selection. A weekday Mass expects only the departments assigned to the weekdays it was held on."
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="mass-name">Name</Label>
          <Input
            id="mass-name"
            placeholder="e.g. Week 3 Community Mass"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="mass-scope">Scope</Label>
          <Select
            value={scope}
            onValueChange={(value) => setScope(value === "sunday" ? "sunday" : "weekday")}
          >
            <SelectTrigger id="mass-scope" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekday">Weekday (Mon–Fri)</SelectItem>
              <SelectItem value="sunday">Sunday</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="mass-participants">Who it is for</Label>
          <Select
            value={participantType}
            onValueChange={(value) =>
              setParticipantType(value === "students" || value === "staff" ? value : "both")
            }
          >
            <SelectTrigger id="mass-participants" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="students">Students</SelectItem>
              <SelectItem value="staff">Staff</SelectItem>
              <SelectItem value="both">Students &amp; staff</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="mass-notes">Notes</Label>
          <Input
            id="mass-notes"
            placeholder="Optional"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
      </div>

      {scope === "weekday" ? (
        <div className="mt-4">
          <Label>Weekdays it was held on</Label>
          <p className="mt-1 text-xs text-muted-foreground">
            Leave out a public holiday: nobody is expected, or absent, because of that day.
          </p>
          <div className="mt-2 flex flex-wrap gap-4">
            {[1, 2, 3, 4, 5].map((day) => (
              <span key={day} className="flex items-center gap-2">
                <Checkbox
                  id={`create-day-${day}`}
                  checked={weekdays.includes(day)}
                  onCheckedChange={() => toggleDay(day)}
                />
                <Label htmlFor={`create-day-${day}`} className="text-sm">
                  {MASS_WEEKDAY_LABELS[day]}
                </Label>
              </span>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-4">
        <Button disabled={blocked || create.isPending} onClick={() => create.mutate()}>
          {create.isPending ? "Creating…" : "Create week"}
        </Button>
      </div>
    </Panel>
  );
}
