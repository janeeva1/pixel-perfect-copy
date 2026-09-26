import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  const clearData = useMutation({
    mutationFn: () => api.admin.clearAllData(),
    onSuccess: () => {
      toast.success("All data cleared successfully");
      queryClient.invalidateQueries({ queryKey: ["dashboard"] });
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
        description="Completely wipe the database and start fresh. This deletes all students, staff, events, scans, and uploads. User accounts are preserved."
      >
        <div className="flex items-center gap-4">
          <Button
            variant="destructive"
            onClick={() => {
              if (
                confirm(
                  "This will DELETE ALL attendance data (students, staff, events, scans). User accounts will remain. Are you sure?",
                )
              ) {
                clearData.mutate();
              }
            }}
            disabled={clearData.isPending}
          >
            {clearData.isPending ? "Clearing…" : "Clear All Data"}
          </Button>
          <span className="text-sm text-muted-foreground">This cannot be undone.</span>
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
    </div>
  );
}
