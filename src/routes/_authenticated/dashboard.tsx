import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { EmptyState, Panel, StatTile } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import {
  CalendarDays,
  ShieldCheck,
  ExternalLink,
  FileText,
  Users,
  Building2,
  Church,
} from "lucide-react";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Attendance Register" },
      {
        name: "description",
        content: "Student and staff master lists, events and recent attendance.",
      },
      { property: "og:title", content: "Dashboard — Attendance Register" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function Dashboard() {
  const { canEdit } = useRoles();
  const dashboard = useQuery({ queryKey: ["dashboard"], queryFn: api.dashboard });
  const data = dashboard.data;

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Students and staff are tracked separately, each with their own events, reports and
            charts.
          </p>
        </div>
        {canEdit ? (
          <div className="flex flex-wrap gap-2">
            <Button asChild>
              <Link to="/import">
                <FileText className="mr-2 size-4" /> Import Data
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/recurring">
                <CalendarDays className="mr-2 size-4" /> Recurring Events
              </Link>
            </Button>
            <Button asChild>
              <Link to="/admin">
                <ShieldCheck className="mr-2 size-4" /> Admin Settings
              </Link>
            </Button>
          </div>
        ) : null}
      </header>

      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-7">
        <StatTile label="Students" value={data?.students} />
        <StatTile label="Undergraduate" value={data?.undergraduates} hint="VUG matric numbers" />
        <StatTile label="Postgraduate" value={data?.postgraduates} hint="VPG matric numbers" />
        <StatTile label="Staff" value={data?.staff} />
        <StatTile label="Student Events" value={data?.studentEvents} />
        <StatTile
          label="Community Mass"
          value={data?.studentCommunityMassEvents}
          hint="Student"
          icon={<Church className="size-4 text-emerald-600" />}
        />
        <StatTile
          label="Other"
          value={data?.studentOtherEvents}
          hint="Student"
          icon={<Users className="size-4 text-blue-600" />}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Staff Events" value={data?.staffEvents} />
        <StatTile
          label="Community Mass"
          value={data?.staffCommunityMassEvents}
          hint="Staff"
          icon={<Church className="size-4 text-emerald-600" />}
        />
        <StatTile
          label="Other"
          value={data?.staffOtherEvents}
          hint="Staff"
          icon={<Building2 className="size-4 text-blue-600" />}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <Panel
          title="Quick Actions"
          description="Create and manage recurring event templates for the semester."
        >
          <Button asChild className="w-full mb-2">
            <Link to="/recurring">
              <CalendarDays className="mr-2 size-4" /> Manage Recurring Events
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full mb-2">
            <Link to="/admin">
              <ShieldCheck className="mr-2 size-4" /> Admin Settings
            </Link>
          </Button>
          <Button asChild variant="outline" className="w-full">
            <Link to="/users">
              <ExternalLink className="mr-2 size-4" /> Users & Permissions
            </Link>
          </Button>
        </Panel>

        <Panel
          title="Recent student events"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/student-events">All</Link>
            </Button>
          }
        >
          {(data?.recentStudentEvents ?? []).length === 0 ? (
            <EmptyState title="No student events yet" />
          ) : (
            <ul className="divide-y divide-border">
              {(data?.recentStudentEvents ?? []).map((event) => (
                <li key={event.id} className="py-3">
                  <Link
                    to="/student-events/$eventId"
                    params={{ eventId: event.id }}
                    className="font-medium hover:underline"
                  >
                    {event.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {event.event_date} · {event.status}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel
          title="Recent staff events"
          actions={
            <Button asChild variant="outline" size="sm">
              <Link to="/staff-events">All</Link>
            </Button>
          }
        >
          {(data?.recentStaffEvents ?? []).length === 0 ? (
            <EmptyState title="No staff events yet" />
          ) : (
            <ul className="divide-y divide-border">
              {(data?.recentStaffEvents ?? []).map((event) => (
                <li key={event.id} className="py-3">
                  <Link
                    to="/staff-events/$eventId"
                    params={{ eventId: event.id }}
                    className="font-medium hover:underline"
                  >
                    {event.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {event.event_date} · {event.status}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Panel title="Student reports">
          <p className="text-sm text-muted-foreground">
            Daily, weekly and monthly percentages, breakdowns by department, level and category,
            with CSV downloads.
          </p>
          <Button asChild className="mt-4" variant="outline">
            <Link to="/reports/students">Open student reports</Link>
          </Button>
        </Panel>
        <Panel title="Staff reports">
          <p className="text-sm text-muted-foreground">
            The same reporting for staff, kept apart from the student numbers throughout.
          </p>
          <Button asChild className="mt-4" variant="outline">
            <Link to="/reports/staff">Open staff reports</Link>
          </Button>
        </Panel>
      </div>

      {!data?.students && !data?.staff ? (
        <div className="panel border-accent/60 p-5">
          <h2 className="font-semibold">Start by importing the master lists</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload the student and staff files once. Events, matching, percentages and charts all
            work from those two lists.
          </p>
        </div>
      ) : null}
    </div>
  );
}
