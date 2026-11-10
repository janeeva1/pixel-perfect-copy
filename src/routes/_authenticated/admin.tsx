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
import { RotateCcw, Wifi, WifiOff, Save, TestTube2 } from "lucide-react";

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
    mutationFn: (config: { host: string; port: number; user: string; password: string; database: string }) =>
      api.admin.saveSyncConfig(config),
    onSuccess: () => {
      toast.success("Sync settings saved");
      queryClient.invalidateQueries({ queryKey: ["sync", "config"] });
      queryClient.invalidateQueries({ queryKey: ["sync", "status"] });
    },
    onError: (error) => toast.error(error.message),
  });

  const testSyncConnection = useMutation({
    mutationFn: (config: { host: string; port: number; user: string; password: string; database: string }) =>
      api.admin.testSyncConnection(config),
    onSuccess: (result) => {
      toast.success(result.message);
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
        title="Synchronization"
        description="Push and pull changes with the shared office database. Runs offline-first: this machine works alone and exchanges its edits with the hub on demand."
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
                  placeholder="••••••••"
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
                      These need looking at: either the two copies hold different edits of the same row
                      at the same moment, or the same person exists under two ids. Nothing was
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
    </div>
  );
}
