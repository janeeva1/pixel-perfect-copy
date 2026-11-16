import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EmptyState, Panel, formatDateTime } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { pick, readSpreadsheet } from "@/lib/spreadsheet";
import {
  MASS_STATUS_LABELS,
  MASS_WEEKDAY_LABELS,
  type MassUploadParticipant,
  type MassWeekParticipantType,
  type MassWeekStatus,
} from "@/lib/types";
import { useRoles } from "@/lib/useAuth";
import { MassWeekReport } from "@/components/MassWeekReport";
import { Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/mass/$weekId/")({
  component: MassWeekPage,
});

const STATUS_FLOW: MassWeekStatus[] = ["draft", "active", "completed", "archived"];

/** Plain words for what an upload to this week may contain. */
function participantDescription(type: MassWeekParticipantType): string {
  if (type === "staff") return "staff files only";
  if (type === "students") return "student files only";
  return "student files and staff files";
}

/** One message for a batch of files: what was added and what was already there. */
function batchMessage(
  results: Array<{ file: string; added: number; skipped: number; error?: string }>,
) {
  const added = results.reduce((sum, item) => sum + item.added, 0);
  const skipped = results.reduce((sum, item) => sum + item.skipped, 0);
  const files = results.filter((item) => !item.error).length;
  const parts = [`${files} file(s): ${added} new scan(s) added`];
  if (skipped > 0) parts.push(`${skipped} already uploaded, skipped`);
  return parts.join(" · ");
}

function MassWeekPage() {
  const { weekId } = Route.useParams();
  const queryClient = useQueryClient();
  const { canEdit, isAdmin } = useRoles();
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploadParticipant, setUploadParticipant] = useState<MassUploadParticipant>("student");
  const [uploadLevel, setUploadLevel] = useState("");
  const [uploadLabel, setUploadLabel] = useState("");
  // The group just uploaded: the report below switches to it.
  const [lastUploaded, setLastUploaded] = useState<MassUploadParticipant | null>(null);

  const week = useQuery({
    queryKey: ["mass-week", weekId],
    queryFn: () => api.mass.week(weekId),
  });

  const uploads = useQuery({
    queryKey: ["mass-uploads", weekId],
    queryFn: () => api.mass.uploads(weekId),
  });

  const levels = useQuery({
    queryKey: ["levels"],
    queryFn: api.levels,
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["mass-week", weekId] });
    queryClient.invalidateQueries({ queryKey: ["mass-uploads", weekId] });
    queryClient.invalidateQueries({ queryKey: ["mass-result", weekId] });
  };

  const setStatus = useMutation({
    mutationFn: (status: MassWeekStatus) => api.mass.setStatus(weekId, status),
    onSuccess: () => {
      toast.success("Status updated");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const isClosedStatus = (status: MassWeekStatus) =>
    status === "completed" || status === "archived";
  const changeStatus = (status: MassWeekStatus) => {
    const current = week.data?.status;
    if (!current || current === status) return;
    if (!isClosedStatus(current) && isClosedStatus(status)) {
      if (
        !window.confirm(
          "Close this week?\n\nWho was expected and who was present are kept as they are now. Staff or students added to the list later will not be counted, and no more files can be added until you reopen it.",
        )
      ) {
        return;
      }
    }
    if (isClosedStatus(current) && !isClosedStatus(status)) {
      if (
        !window.confirm(
          "Reopen this week?\n\nFiles can be added again, and people added to the staff or student list will be put on its expected list after their next import.",
        )
      ) {
        return;
      }
    }
    setStatus.mutate(status);
  };

  const setWeekdays = useMutation({
    mutationFn: (days: number[]) => api.mass.setWeekdays(weekId, days),
    onSuccess: () => {
      toast.success("Weekdays saved");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const reset = useMutation({
    mutationFn: (participantType: MassUploadParticipant) => api.mass.reset(weekId, participantType),
    onSuccess: () => {
      toast.success("Reset. The next upload rebuilds the snapshot.");
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  const deleteWeek = useMutation({
    mutationFn: () => api.mass.deleteWeek(weekId),
    onSuccess: () => {
      toast.success("Week deleted");
      queryClient.invalidateQueries({ queryKey: ["mass-weeks"] });
    },
    onError: (e) => toast.error(e.message),
  });

  // Several files can be chosen at once; they go up one after another, and
  // rows already uploaded (from any earlier file) are skipped by the server.
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      const results: Array<{ file: string; added: number; skipped: number; error?: string }> = [];
      for (const file of files) {
        try {
          const { rows: sheet } = await readSpreadsheet(file);
          const rows = sheet.map((row) => ({
            scanNumber: pick(row, "ID", "id", "Id", "userId", "card") || null,
            name: pick(row, "NAME", "name", "Name", "userName") || null,
            scannedAt: pick(row, "Time", "time", "DATE_TIME", "datetime", "CheckInTime") || null,
            machineId:
              pick(
                row,
                "Machine_ID",
                "machine_id",
                "machineId",
                "MachineID",
                "machineID",
                "staff_id_on_machine",
                "staffIdOnMachine",
              ) || null,
          }));
          const result = await api.mass.upload(weekId, {
            participantType: uploadParticipant,
            level:
              uploadParticipant === "student" && uploadLevel.trim() ? uploadLevel.trim() : null,
            fileName: file.name,
            label: uploadLabel.trim() || null,
            rows,
          });
          results.push({ file: file.name, added: result.added, skipped: result.skipped });
        } catch (error) {
          results.push({ file: file.name, added: 0, skipped: 0, error: (error as Error).message });
        }
      }
      return results;
    },
    onSuccess: (results) => {
      toast.success(batchMessage(results));
      for (const item of results) {
        if (item.error) toast.error(`${item.file}: ${item.error}`);
      }
      if (results.some((item) => !item.error)) setLastUploaded(uploadParticipant);
      refresh();
    },
    onError: (e) => toast.error(e.message),
  });

  // The picker must start on something the week actually covers. A staff-only
  // week defaulting to "Students" meant the first upload was refused with "its
  // uploads must be staff files", which reads as if the file were wrong when
  // the selection was. Chosen once per week, and only corrected when the week's
  // scope does not include the current choice, so changing it is never undone.
  const covered: MassUploadParticipant[] =
    week.data?.participant_type === "both"
      ? ["student", "staff"]
      : week.data?.participant_type === "staff"
        ? ["staff"]
        : ["student"];
  useEffect(() => {
    if (!covered.includes(uploadParticipant)) setUploadParticipant(covered[0] ?? "student");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week.data?.participant_type]);

  if (week.isError) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        {(week.error as Error).message}
      </p>
    );
  }
  if (!week.data) return <p className="text-sm text-muted-foreground">Loading the week…</p>;

  const record = week.data;
  const hasUploads = (uploads.data?.uploads.length ?? 0) > 0;
  const closed = week.data?.status === "completed" || week.data?.status === "archived";
  const coveredParticipants: MassUploadParticipant[] =
    record.participant_type === "both"
      ? ["student", "staff"]
      : record.participant_type === "staff"
        ? ["staff"]
        : ["student"];

  return (
    <div className="space-y-6">
      <Panel
        title={record.name}
        description={[
          record.scope === "sunday" ? "Sunday Mass" : "Weekday Mass",
          MASS_STATUS_LABELS[record.status],
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            <Link to="/mass/$weekId/reports" params={{ weekId }}>
              <Button variant="outline">Report on its own page</Button>
            </Link>
            {isAdmin && (
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (
                    window.confirm(
                      "Delete this week? All its uploads, scans and expected snapshots will be permanently removed.",
                    )
                  ) {
                    deleteWeek.mutate();
                  }
                }}
                disabled={deleteWeek.isPending}
              >
                <Trash2 className="mr-2 h-4 w-4" />
                {deleteWeek.isPending ? "Deleting…" : "Delete week"}
              </Button>
            )}
          </>
        }
      >
        {record.notes ? <p className="text-sm text-muted-foreground">{record.notes}</p> : null}
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted-foreground">Status:</span>
          {STATUS_FLOW.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={record.status === status ? "default" : "outline"}
              disabled={!canEdit || setStatus.isPending}
              onClick={() => changeStatus(status)}
            >
              {MASS_STATUS_LABELS[status]}
            </Button>
          ))}
        </div>
        <div
          className={`mt-4 flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm ${
            closed ? "border-border bg-muted/40" : "border-amber-200 bg-amber-50/60"
          }`}
        >
          {closed ? (
            <span>
              This week is <span className="font-medium">closed</span>: who was expected and who was
              present no longer change, even when people are added to the staff or student list.
              Reopen it to add files.
            </span>
          ) : (
            <span>
              Finished uploading? Close the week so that staff or students added to the list later
              are not counted in it.
            </span>
          )}
          {canEdit ? (
            <Button
              size="sm"
              variant={closed ? "outline" : "default"}
              disabled={setStatus.isPending}
              onClick={() => changeStatus(closed ? "active" : "completed")}
            >
              {closed ? "Reopen week" : "Close week — stop counting"}
            </Button>
          ) : null}
        </div>
      </Panel>

      {record.scope === "weekday" ? (
        <WeekdayPanel
          weekId={weekId}
          weekdays={record.weekdays}
          hasUploads={hasUploads}
          canEdit={canEdit}
          onSave={(days) => setWeekdays.mutate(days)}
          saving={setWeekdays.isPending}
        />
      ) : (
        <Panel
          title="Expected population"
          description="A Sunday Mass expects every undergraduate except those whose registrar record says Religious."
        >
          <p className="text-sm text-muted-foreground">
            No weekday selection applies to a Sunday Mass.
          </p>
        </Panel>
      )}

      {canEdit && closed ? (
        <Panel title="Upload machine scans" description="This week is closed.">
          <p className="text-sm text-muted-foreground">
            Reopen the week (above) to add files. Closed weeks keep their numbers.
          </p>
        </Panel>
      ) : null}

      {canEdit && !closed ? (
        <Panel
          title="Upload machine scans"
          description={`Add clock-in, clock-out or re-export files. Every scan is kept and classified present, out of scope or unmatched. This week takes ${participantDescription(record.participant_type)}; the file you choose must be a matching one.`}
        >
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label htmlFor="upload-participant">Participants</Label>
              <Select
                value={uploadParticipant}
                onValueChange={(value) =>
                  setUploadParticipant(value === "staff" ? "staff" : "student")
                }
              >
                <SelectTrigger id="upload-participant" className="w-36">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {coveredParticipants.map((participant) => (
                    <SelectItem key={participant} value={participant}>
                      {participant === "student" ? "Students" : "Staff"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {uploadParticipant === "student" ? (
              <div className="space-y-1">
                <Label htmlFor="upload-level">Level (optional)</Label>
                <Select
                  value={uploadLevel || "all"}
                  onValueChange={(value) => setUploadLevel(value === "all" ? "" : value)}
                >
                  <SelectTrigger id="upload-level" className="h-9 w-32">
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
              <Label htmlFor="upload-label">Label (optional)</Label>
              <Input
                id="upload-label"
                className="h-9 w-40"
                placeholder="e.g. clock-in"
                value={uploadLabel}
                onChange={(e) => setUploadLabel(e.target.value)}
              />
            </div>
            <input
              ref={fileRef}
              type="file"
              accept=".csv,.xlsx,.xls"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                if (files.length > 0) {
                  upload.mutate(files, { onSettled: () => (event.target.value = "") });
                }
              }}
            />
            <Button
              variant="outline"
              disabled={upload.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {upload.isPending
                ? "Uploading…"
                : `Choose ${uploadParticipant === "staff" ? "staff" : "student"} file(s)`}
            </Button>
            <span className="text-xs text-muted-foreground">Expected columns: ID, NAME, Time</span>
          </div>
          {upload.isError ? (
            <p className="mt-3 text-sm text-rose-600">{(upload.error as Error).message}</p>
          ) : null}
        </Panel>
      ) : null}

      <Panel
        title="Uploads"
        description="Each file is listed separately with how its rows classified."
        actions={
          canEdit ? (
            <span className="flex flex-wrap items-center gap-2">
              {coveredParticipants.map((participant) => (
                <Button
                  key={participant}
                  size="sm"
                  variant="outline"
                  className="text-rose-600"
                  disabled={reset.isPending || !hasUploads || closed}
                  onClick={() => {
                    if (
                      window.confirm(
                        `Reset ${participant === "student" ? "student" : "staff"} data for this week? Every upload, scan and expected row for it is deleted.`,
                      )
                    ) {
                      reset.mutate(participant);
                    }
                  }}
                >
                  Reset {participant === "student" ? "students" : "staff"}
                </Button>
              ))}
            </span>
          ) : null
        }
      >
        {uploads.data && uploads.data.uploads.length > 0 ? (
          <div className="overflow-auto rounded-md border border-border">
            <table className="w-full text-sm">
              <thead className="bg-card">
                <tr>
                  {[
                    "File",
                    "For",
                    "Level",
                    "Label",
                    "Rows",
                    "Present",
                    "Out of scope",
                    "Unmatched",
                    "Uploaded",
                  ].map((labelText) => (
                    <th
                      key={labelText}
                      className="border-b border-border px-3 py-2 text-left font-medium"
                    >
                      {labelText}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {uploads.data.uploads.map((item) => (
                  <tr key={item.id} className="border-b border-border/60 last:border-0">
                    <td className="px-3 py-2">{item.file_name}</td>
                    <td className="px-3 py-2">
                      {item.participant_type === "student" ? "Students" : "Staff"}
                    </td>
                    <td className="px-3 py-2">{item.level ?? "—"}</td>
                    <td className="px-3 py-2">{item.label ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{item.row_count}</td>
                    <td className="px-3 py-2 tabular-nums">{item.present_count}</td>
                    <td className="px-3 py-2 tabular-nums">{item.out_of_scope_count}</td>
                    <td className="px-3 py-2 tabular-nums">{item.unmatched_count}</td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatDateTime(item.uploaded_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No uploads yet">Choose a machine file above to begin.</EmptyState>
        )}
      </Panel>

      <MassWeekReport weekId={weekId} title="Report" uploadedFor={lastUploaded} />
    </div>
  );
}

function WeekdayPanel({
  weekId,
  weekdays,
  hasUploads,
  canEdit,
  onSave,
  saving,
}: {
  weekId: string;
  weekdays: number[];
  hasUploads: boolean;
  canEdit: boolean;
  onSave: (days: number[]) => void;
  saving: boolean;
}) {
  const [selected, setSelected] = useState<number[]>(weekdays);

  // Re-sync when the server value changes (after a save or a refetch).
  const [lastServer, setLastServer] = useState(weekdays.join(","));
  const serverKey = weekdays.join(",");
  if (serverKey !== lastServer) {
    setLastServer(serverKey);
    setSelected(weekdays);
  }

  const dirty = selected.slice().sort().join(",") !== weekdays.slice().sort().join(",");

  function toggle(day: number) {
    setSelected((current) =>
      current.includes(day) ? current.filter((d) => d !== day) : [...current, day].sort(),
    );
  }

  return (
    <Panel
      title="Weekdays this week covered"
      description={
        hasUploads
          ? "Locked while uploads exist: the expected snapshot was built from this selection. Reset the week to change it."
          : "The public-holiday switch. Leave out a day and nobody is expected, or absent, because of it."
      }
      actions={
        canEdit && !hasUploads ? (
          <Button
            size="sm"
            disabled={!dirty || saving || selected.length === 0}
            onClick={() => onSave(selected)}
          >
            {saving ? "Saving…" : "Save weekdays"}
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-4">
        {[1, 2, 3, 4, 5].map((day) => (
          <span key={day} className="flex items-center gap-2">
            <input
              type="checkbox"
              id={`week-day-${weekId}-${day}`}
              className="size-4"
              checked={selected.includes(day)}
              disabled={!canEdit || hasUploads}
              onChange={() => toggle(day)}
            />
            <Label htmlFor={`week-day-${weekId}-${day}`} className="text-sm">
              {MASS_WEEKDAY_LABELS[day]}
            </Label>
          </span>
        ))}
      </div>
      {selected.length === 0 ? (
        <p className="mt-3 text-sm text-amber-600">
          No weekdays selected. Save only if Community Mass was not held at all this week.
        </p>
      ) : null}
    </Panel>
  );
}
