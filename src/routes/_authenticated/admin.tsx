import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppUpdate } from "@/components/AppUpdate";
import { DataRow, DataTable, EmptyState, Panel, StatTile } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import { toast } from "sonner";
import { RotateCcw, Wifi, WifiOff, Save, TestTube2, AlertTriangle, Trash2 } from "lucide-react";

export const Route = createFileRoute("/_authenticated/admin")({
  beforeLoad: ({ context }) => {
    if (!context.me.roles.includes("admin")) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: AdminPage,
});

function AdminPage() {
  const queryClient = useQueryClient();
  const { canEdit } = useRoles();

  const [host, setHost] = useState("");
  const [port, setPort] = useState(3306);
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");

  const previewDeduplication = useMutation({
    mutationFn: () => api.admin.previewStaffDeduplication(),
    onError: (error) => toast.error(error.message),
  });

  const deduplicateStaff = useMutation({
    mutationFn: () => api.admin.deduplicateStaff(),
    onSuccess: (result) => {
      toast.success(
        `Merged ${result.groupsMerged} group(s): ${result.duplicatesRemoved} duplicate record(s) removed, ` +
          `${result.scanRecordsUpdated} scan(s) moved. ${result.needsReview} group(s) left for review.`,
      );
      // Show what is left, so the list never describes rows that are gone.
      previewDeduplication.mutate();
    },
    onError: (error) => toast.error(error.message),
  });

  const syncStatus = useQuery({
    queryKey: ["sync", "status"],
    queryFn: () => api.admin.syncStatus(),
  });

  const syncConfig = useQuery({
    queryKey: ["sync", "config"],
    queryFn: () => api.admin.getSyncConfig(),
  });

  useEffect(() => {
    if (syncConfig.data) {
      setHost(syncConfig.data.host);
      setPort(syncConfig.data.port);
      setUser(syncConfig.data.user);
      setDatabase(syncConfig.data.database);
      // Password is not returned for security
    }
  }, [syncConfig.data]);

  const runSync = useMutation({
    mutationFn: () => api.admin.runSync(),
    onSuccess: (result) => {
      toast.success(result.message);
      queryClient.invalidateQueries({ queryKey: ["sync", "status"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const saveSyncConfig = useMutation({
    mutationFn: (config: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    }) => api.admin.saveSyncConfig(config),
    onSuccess: () => {
      toast.success("Sync settings saved");
      setPassword("");
      queryClient.invalidateQueries({ queryKey: ["sync", "config"] });
      queryClient.invalidateQueries({ queryKey: ["sync", "status"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const testSyncConnection = useMutation({
    mutationFn: (config: {
      host: string;
      port: number;
      user: string;
      password: string;
      database: string;
    }) => api.admin.testSyncConnection(config),
    onSuccess: (result) => {
      // The server answers 200 with ok: false when the hub refuses, so the
      // outcome has to be read from the body, not from the HTTP status.
      if (result.ok) toast.success(result.message);
      else toast.error(`Connection failed: ${result.message}`);
    },
    onError: (error) => toast.error(error.message),
  });

  const clearData = useMutation({
    mutationFn: () => api.admin.clearAllData(),
    onSuccess: () => {
      toast.success("All data cleared successfully");
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const clearEvents = useMutation({
    mutationFn: () => api.admin.clearEvents(),
    onSuccess: () => {
      toast.success("Events cleared successfully");
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      queryClient.invalidateQueries({ queryKey: ["mass-weeks"] });
    },
    onError: (error) => toast.error(error.message),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Admin Settings</h1>
        <p className="text-sm text-muted-foreground">
          Dangerous actions that affect all data. Use with caution.
        </p>
      </header>

      <Panel
        title="Database Management"
        description="Clear the events and their scans, or wipe the whole database and start fresh. The student list, the staff list and the department weekdays are kept either way unless you clear everything."
      >
        <div className="flex flex-wrap items-center gap-4">
          <Button
            variant="outline"
            onClick={() => {
              if (
                confirm(
                  "This will DELETE all events, scans, uploads, recurring templates and weekly Mass records. Students, staff and department weekdays will remain. Are you sure?",
                )
              ) {
                clearEvents.mutate();
              }
            }}
            disabled={clearEvents.isPending || clearData.isPending}
          >
            {clearEvents.isPending ? "Clearing events…" : "Clear Events Only"}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              if (
                confirm(
                  "This will DELETE ALL attendance data (students, staff, events, scans, weekly Mass records). User accounts will remain. Are you sure?",
                )
              ) {
                clearData.mutate();
              }
            }}
            disabled={clearData.isPending || clearEvents.isPending}
          >
            {clearData.isPending ? "Clearing…" : "Clear All Data"}
          </Button>
          <span className="text-sm text-muted-foreground">These cannot be undone.</span>
        </div>
      </Panel>

      <Panel
        title="Event Management"
        description="Manage existing events: suspend, activate, edit, or delete."
      >
        <Button variant="outline" onClick={() => (window.location.href = "/student-events")}>
          Manage Student Events
        </Button>
        <Button
          variant="outline"
          className="ml-2"
          onClick={() => (window.location.href = "/staff-events")}
        >
          Manage Staff Events
        </Button>
      </Panel>

      <Panel
        title="Recurring Events"
        description="Create and manage recurring event templates (weekly schedules)."
      >
        <Button variant="outline" onClick={() => (window.location.href = "/recurring")}>
          Manage Recurring Templates
        </Button>
      </Panel>

      <Panel title="User Management" description="View and manage user accounts and roles.">
        <Button variant="outline" onClick={() => (window.location.href = "/users")}>
          Manage Users
        </Button>
      </Panel>

      <Panel
        title="Application Update"
        description="Bring the desktop app up to date without reinstalling it: look for a newer build, download it, and restart into it. The installed database and the accounts in it are not touched by an update."
      >
        <AppUpdate />
      </Panel>

      <Panel
        title="Advanced: MariaDB hub synchronization"
        description="Only for offices that run their own MariaDB server. For computers in the same office, use Sync computers (in the menu) instead: it needs nothing but this app."
      >
        {/* Sync Configuration */}
        <div className="space-y-4">
          <div className="border rounded-lg p-4 bg-muted/30">
            <h4 className="font-medium mb-3 flex items-center gap-2">
              <Wifi className="h-4 w-4" />
              Hub Database Configuration
            </h4>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 mb-4">
              <div className="space-y-1">
                <Label htmlFor="sync-host">Host</Label>
                <Input
                  id="sync-host"
                  placeholder="e.g. 192.168.1.50"
                  value={syncConfig.data?.host ?? ""}
                  onChange={(e) => setHost(e.target.value)}
                  disabled={saveSyncConfig.isPending}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sync-port">Port</Label>
                <Input
                  id="sync-port"
                  type="number"
                  value={port}
                  onChange={(e) => setPort(Number(e.target.value))}
                  disabled={saveSyncConfig.isPending}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sync-user">Username</Label>
                <Input
                  id="sync-user"
                  placeholder="e.g. sync_user"
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  disabled={saveSyncConfig.isPending}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="sync-database">Database</Label>
                <Input
                  id="sync-database"
                  placeholder="e.g. attendance_sync"
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  disabled={saveSyncConfig.isPending}
                />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label htmlFor="sync-password">Password</Label>
                <Input
                  id="sync-password"
                  type="password"
                  placeholder={
                    syncConfig.data?.hasPassword ? "Saved (leave blank to keep)" : "••••••••"
                  }
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={saveSyncConfig.isPending}
                  autoComplete="current-password"
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                onClick={() => testSyncConnection.mutate({ host, port, user, password, database })}
                disabled={testSyncConnection.isPending || !host || !database}
              >
                <TestTube2 className="mr-2 h-4 w-4" />
                {testSyncConnection.isPending ? "Testing…" : "Test Connection"}
              </Button>
              <Button
                onClick={() => saveSyncConfig.mutate({ host, port, user, password, database })}
                disabled={saveSyncConfig.isPending || !host || !database}
              >
                <Save className="mr-2 h-4 w-4" />
                {saveSyncConfig.isPending ? "Saving…" : "Save Configuration"}
              </Button>
              {syncConfig.data?.configured && (
                <span className="text-sm text-green-600 flex items-center gap-1">
                  <Wifi className="h-4 w-4" /> Configured
                </span>
              )}
            </div>
          </div>

          {/* Sync Action */}
          <div className="border-t pt-4">
            <div className="flex flex-wrap items-center gap-4">
              <Button
                onClick={() => runSync.mutate()}
                disabled={runSync.isPending || !syncStatus.data?.configured}
              >
                <RotateCcw className="mr-2 h-4 w-4" />
                {runSync.isPending ? "Synchronizing…" : "Synchronize Now"}
              </Button>
              {syncStatus.data && !syncStatus.data.configured && (
                <span className="text-sm text-muted-foreground">
                  Not configured — enter hub database details above and save, then test connection.
                </span>
              )}
              {runSync.data && (
                <span
                  className={
                    runSync.data.conflicts > 0
                      ? "text-sm text-amber-700 dark:text-amber-400"
                      : "text-sm text-muted-foreground"
                  }
                >
                  {runSync.data.message}
                  {runSync.data.conflicts > 0 && (
                    <>
                      {" "}
                      These need looking at: either the two copies hold different edits of the same
                      row at the same moment, or the same person exists under two ids. Nothing was
                      overwritten.
                    </>
                  )}
                </span>
              )}
              {runSync.error && (
                <span className="text-sm text-destructive">{(runSync.error as Error).message}</span>
              )}
            </div>
          </div>
        </div>
      </Panel>

      <Panel
        title="Staff Deduplication"
        description="Find staff entered more than once. Only records with the same name and the same staff or machine number are merged; anything less certain is listed for you to check. Merges are not synced, so run this on each computer."
      >
        <div className="space-y-4">
          <Button
            variant="outline"
            onClick={() => previewDeduplication.mutate()}
            disabled={previewDeduplication.isPending}
          >
            {previewDeduplication.isPending
              ? "Scanning for duplicates…"
              : "Scan for Duplicate Staff"}
          </Button>

          {previewDeduplication.data && (
            <>
              {previewDeduplication.data.mergeable.length === 0 &&
              previewDeduplication.data.needsReview.length === 0 ? (
                <p className="text-sm text-green-600">
                  No duplicates found. Staff records are clean.
                </p>
              ) : (
                <div className="space-y-4">
                  {previewDeduplication.data.mergeable.length > 0 && (
                    <div className="rounded-lg border bg-amber-50 p-4">
                      <h4 className="mb-2 flex items-center gap-2 font-medium text-amber-800">
                        <AlertTriangle className="h-4 w-4" />
                        Will be merged ({previewDeduplication.data.mergeable.length} groups)
                      </h4>
                      <p className="mb-3 text-sm text-amber-700">
                        Same name and the same staff number (however it is written, e.g. "SA 534"
                        and "SAC534") or machine number: one person entered more than once. Their
                        scans move to the record that is kept.
                      </p>
                      <div className="max-h-60 space-y-2 overflow-y-auto">
                        {previewDeduplication.data.mergeable.map((group) => (
                          <div key={group.key} className="rounded border bg-white p-3">
                            <div className="font-medium">Keep: {group.canonicalName}</div>
                            <div className="text-sm text-muted-foreground">
                              {group.names.length} records: {group.names.join(", ")}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {previewDeduplication.data.needsReview.length > 0 && (
                    <div className="rounded-lg border bg-slate-50 p-4">
                      <h4 className="mb-2 flex items-center gap-2 font-medium text-slate-800">
                        <AlertTriangle className="h-4 w-4" />
                        Check by hand ({previewDeduplication.data.needsReview.length} groups)
                      </h4>
                      <p className="mb-3 text-sm text-slate-700">
                        These match on only one detail and may be different people, so they are
                        never merged automatically. Fix them on the Staff page if they are the same
                        person.
                      </p>
                      <div className="max-h-60 space-y-2 overflow-y-auto">
                        {previewDeduplication.data.needsReview.map((group) => (
                          <div key={group.key} className="rounded border bg-white p-3">
                            <div className="font-medium">{group.names.join(" / ")}</div>
                            <div className="text-sm text-muted-foreground">{group.reason}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {previewDeduplication.data.mergeable.length > 0 && (
                    <Button
                      variant="destructive"
                      onClick={() => {
                        if (
                          confirm(
                            "This will permanently merge the duplicate staff records listed above and move their scans. Continue?",
                          )
                        ) {
                          deduplicateStaff.mutate();
                        }
                      }}
                      disabled={deduplicateStaff.isPending || previewDeduplication.isPending}
                      className="w-full"
                    >
                      {deduplicateStaff.isPending
                        ? "Merging…"
                        : `Merge ${previewDeduplication.data.mergeable.length} duplicate group(s)`}
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </Panel>
    </div>
  );
}
