import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { AppUpdate } from "@/components/AppUpdate";
import { DataRow, DataTable, EmptyState, Panel, StatTile } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import { toast } from "sonner";

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

  const syncStatus = useQuery({
    queryKey: ["sync", "status"],
    queryFn: () => api.admin.syncStatus(),
  });

  const runSync = useMutation({
    mutationFn: () => api.admin.runSync(),
    onSuccess: (result) => {
      toast.success(result.message);
      queryClient.invalidateQueries({ queryKey: ["sync", "status"] });
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
        <div className="flex flex-wrap items-center gap-4">
          <Button
            onClick={() => runSync.mutate()}
            disabled={runSync.isPending || (syncStatus.data && !syncStatus.data.configured)}
          >
            {runSync.isPending ? "Synchronizing…" : "Synchronize Now"}
          </Button>
          {syncStatus.data && !syncStatus.data.configured && (
            <span className="text-sm text-muted-foreground">
              Not configured — set SYNC_DB_HOST and SYNC_DB_NAME for this computer to enable it. In
              the desktop app that is the <code>sync.env</code> file beside the database.
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
      </Panel>
    </div>
  );
}
