import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DataRow,
  DataTable,
  EmptyState,
  Panel,
  PercentBar,
  StatTile,
  categoryLabel,
  formatDateTime,
} from "@/components/attendance-ui";
import { EventForm } from "@/components/EventForm";
import { EventStatusToggle } from "@/components/EventStatusToggle";
import { api } from "@/lib/api";
import { pick, readSpreadsheet } from "@/lib/spreadsheet";
import { useRoles } from "@/lib/useAuth";
import { MatchReviewBanner } from "@/components/MatchReviewDialog";
import { ReportFilterBar } from "@/components/ReportFilters";
import {
  EMPTY_FILTER,
  passesFilter,
  shownOf,
  type FilterFields,
  type ReportFilterState,
} from "@/lib/report-filter";
import type { GroupKind } from "@/lib/types";

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

/**
 * One event, for either group. Uploading is additive: an event can take a
 * clock-in file, a clock-out file and later re-exports, and every scan is kept.
 * A new upload reopens a finalized event, because the numbers changed.
 */
export function EventResultView({ group, eventId }: { group: GroupKind; eventId: string }) {
  const queryClient = useQueryClient();
  const { canEdit } = useRoles();
  const fileRef = useRef<HTMLInputElement>(null);
  const [label, setLabel] = useState("");
  const [editing, setEditing] = useState(false);
  const [filter, setFilter] = useState<ReportFilterState>(EMPTY_FILTER);

  const result = useQuery({
    queryKey: [group, "event", eventId],
    queryFn: () => (group === "student" ? api.studentEvent(eventId) : api.staffEvent(eventId)),
  });

  // The edit form saves every field, so its level and department pickers have to
  // offer everything the event might already be set to. Otherwise a level the
  // form had never heard of would read as unset and be dropped by the save.
  const levelOptions = useQuery({
    queryKey: ["students", "levels"],
    queryFn: () => api.students({ limit: 1 }),
    enabled: group === "student" && editing,
  });
  const departmentOptions = useQuery({
    queryKey: ["departments"],
    queryFn: api.departments,
    enabled: group === "student" && editing,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: [group, "event", eventId] });

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
              pick(row, "Machine_ID", "machine_id", "machineId", "MachineID", "machineID") || null,
          }));
          const result = await api.uploadScans(group, eventId, {
            fileName: file.name,
            label: label || null,
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
      void refresh();
    },
  });

  if (result.isError) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        {(result.error as Error).message}
      </p>
    );
  }
  if (!result.data) return <p className="text-sm text-muted-foreground">Loading the event…</p>;

  const fields = (row: {
    name: string;
    code: string;
    level: string | null;
    department_code: string | null;
  }): FilterFields => ({
    name: row.name,
    number: row.code,
    department: row.department_code,
    level: row.level,
  });
  const presentFields = result.data.presentList.map(fields);
  const absentFields = result.data.absentList.map(fields);
  const outFields = result.data.outOfScopeList.map(fields);
  const presentRows = result.data.presentList.filter((_, index) =>
    passesFilter(filter, presentFields[index]!),
  );
  const absentRows = result.data.absentList.filter((_, index) =>
    passesFilter(filter, absentFields[index]!),
  );
  const outRows = result.data.outOfScopeList.filter((_, index) =>
    passesFilter(filter, outFields[index]!),
  );
  // Unmatched scans have only what the machine printed: found by text alone.
  const unmatchedRows = result.data.unmatchedList.filter((row) =>
    passesFilter(
      { ...filter, department: "", day: "", level: "" },
      { name: row.scanned_name, number: row.scan_number },
    ),
  );

  const event = result.data.event;
  // Reports wait until every uncertain match is confirmed (the server refuses too).
  const blocked = result.data.pendingReview + result.data.lookAlikes > 0;
  const scope = [
    "category" in event && event.category ? categoryLabel(event.category) : "everyone",
    "level" in event && event.level ? `level ${event.level}` : null,
    "department_code" in event && event.department_code
      ? `department ${event.department_code}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="space-y-6">
      <MatchReviewBanner
        context={{ type: "event", kind: group, eventId }}
        pendingScans={result.data.pendingReview}
        lookAlikes={result.data.lookAlikes}
      />
      <Panel
        title={event.title}
        description={`${event.event_date} · ${scope} · ${event.status}`}
        actions={
          <>
            {blocked ? (
              <Button variant="outline" disabled title="Confirm the matches first">
                Download CSV
              </Button>
            ) : (
              <a href={api.eventExportUrl(group, eventId)} download>
                <Button variant="outline">Download CSV</Button>
              </a>
            )}
            {canEdit ? (
              <>
                <Button variant="outline" onClick={() => setEditing((open) => !open)}>
                  {editing ? "Stop editing" : "Edit"}
                </Button>
                <EventStatusToggle group={group} event={event} size="default" />
              </>
            ) : null}
          </>
        }
      >
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatTile label="Expected" value={result.data.expected} hint="From the master list" />
          <StatTile label="Present" value={result.data.present} tone="good" />
          <StatTile
            label="Absent"
            value={result.data.absent}
            tone={result.data.absent > 0 ? "bad" : "good"}
          />
          <StatTile
            label="Out of scope"
            value={result.data.outOfScope}
            tone={result.data.outOfScope > 0 ? "warn" : "default"}
            hint="Scanned, but not in this event's scope"
          />
          <StatTile
            label="Unmatched"
            value={result.data.unmatched}
            tone={result.data.unmatched > 0 ? "warn" : "default"}
            hint="No match in the master list"
          />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-6 text-sm">
          <PercentBar value={result.data.percent} />
          <span className="text-muted-foreground">
            {result.data.uploads} upload{result.data.uploads === 1 ? "" : "s"} · {result.data.scans}{" "}
            scan{result.data.scans === 1 ? "" : "s"}
            {result.data.firstScanAt ? ` · first ${formatDateTime(result.data.firstScanAt)}` : ""}
            {result.data.lastScanAt ? ` · last ${formatDateTime(result.data.lastScanAt)}` : ""}
          </span>
        </div>
      </Panel>

      {canEdit && editing ? (
        <Panel
          title="Edit event"
          description="Changing the scope changes who is expected, so the counts above are worked out again from the master list on the next report."
        >
          <EventForm
            group={group}
            event={event}
            levels={levelOptions.data?.levels ?? []}
            departments={departmentOptions.data ?? []}
            onSaved={() => setEditing(false)}
          />
        </Panel>
      ) : null}

      {canEdit ? (
        <Panel
          title="Upload machine scans"
          description="Add as many files as the event needs: clock-in, then clock-out, then a re-export. Each upload is listed separately below."
        >
          <div className="flex flex-wrap items-center gap-3">
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
            <Input
              className="h-9 w-44"
              placeholder="Label, e.g. clock-in"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <Button
              variant="outline"
              disabled={upload.isPending}
              onClick={() => fileRef.current?.click()}
            >
              {upload.isPending ? "Uploading…" : "Choose machine file(s)"}
            </Button>
            <span className="text-xs text-muted-foreground">Expected columns: ID, NAME, Time</span>
          </div>
          {upload.isError ? (
            <p className="mt-3 text-sm text-rose-600">{(upload.error as Error).message}</p>
          ) : null}
          {upload.isSuccess ? (
            <p className="mt-3 text-sm text-emerald-600">{batchMessage(upload.data)}</p>
          ) : null}

          {result.data.uploadList.length > 0 ? (
            <div className="mt-4 overflow-auto rounded-md border border-border">
              <table className="w-full text-sm">
                <thead className="bg-card">
                  <tr>
                    {[
                      "File",
                      "Label",
                      "Rows",
                      "In scope",
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
                  {result.data.uploadList.map((item) => (
                    <tr key={item.id} className="border-b border-border/60 last:border-0">
                      <td className="px-3 py-2">{item.file_name}</td>
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
          ) : null}
        </Panel>
      ) : null}

      <ReportFilterBar
        state={filter}
        onChange={setFilter}
        rows={[...presentFields, ...absentFields, ...outFields]}
        placeholder={
          group === "student"
            ? "Search by name, matric number or department"
            : "Search by name, staff number or department/unit"
        }
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
            <DataTable head={["Name", "Code", "Level", "Department", "Scans", "First", "Last"]}>
              {presentRows.map((row) => (
                <DataRow
                  key={row.person_id}
                  cells={[
                    row.name,
                    <span className="font-mono text-xs">{row.code}</span>,
                    row.level ? `Level ${row.level}` : "—",
                    row.department_code ?? "—",
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
          {absentRows.length === 0 ? (
            <EmptyState
              title={
                result.data.absentList.length === 0
                  ? "Nobody is absent"
                  : "Nobody here matches the search"
              }
            />
          ) : (
            <DataTable head={["Name", "Code", "Level", "Department"]}>
              {absentRows.map((row) => (
                <DataRow
                  key={row.person_id}
                  cells={[
                    row.name,
                    <span className="font-mono text-xs">{row.code}</span>,
                    row.level ? `Level ${row.level}` : "—",
                    row.department_code ?? "—",
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
                  ? "No scans fell outside the scope"
                  : "Nobody here matches the search"
              }
            />
          ) : (
            <DataTable head={["Name", "Code", "Level", "Department", "Scans"]}>
              {outRows.map((row) => (
                <DataRow
                  key={row.person_id}
                  cells={[
                    row.name,
                    <span className="font-mono text-xs">{row.code}</span>,
                    row.level ? `Level ${row.level}` : "—",
                    row.department_code ?? "—",
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
    </div>
  );
}
