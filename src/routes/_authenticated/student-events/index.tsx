import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Panel, EmptyState, categoryLabel } from "@/components/attendance-ui";
import { EventForm } from "@/components/EventForm";
import { EventStatusToggle } from "@/components/EventStatusToggle";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";

export const Route = createFileRoute("/_authenticated/student-events/")({
  component: StudentEvents,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StudentEvents() {
  const { canEdit } = useRoles();
  const list = useQuery({
    queryKey: ["student-events"],
    queryFn: () => api.studentEvents({ limit: 50 }),
  });
  const students = useQuery({
    queryKey: ["students", "levels"],
    queryFn: () => api.students({ limit: 1 }),
  });
  const departments = useQuery({ queryKey: ["departments"], queryFn: api.departments });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Student events</h1>
        <p className="text-sm text-muted-foreground">
          One event is one attendance exercise. Narrow it to a category, level and department, or
          leave it open for a general or mass attendance.
        </p>
      </header>

      {canEdit ? (
        <Panel title="New event">
          <EventForm
            group="student"
            levels={students.data?.levels ?? []}
            departments={departments.data ?? []}
          />
        </Panel>
      ) : null}

      <Panel title="Events">
        {(list.data ?? []).length === 0 ? (
          <EmptyState title="No events yet">
            {list.isLoading ? "Loading…" : "Create the first student event above."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {(list.data ?? []).map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <Link
                    to="/student-events/$eventId"
                    params={{ eventId: event.id }}
                    className="font-medium hover:underline"
                  >
                    {event.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {event.event_date} ·{" "}
                    {[
                      event.category ? categoryLabel(event.category) : "everyone",
                      event.level ? `level ${event.level}` : null,
                      event.department_code ? `department ${event.department_code}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}{" "}
                    · {event.status === "finalized" ? "closed" : "open"}
                  </p>
                </div>
                {canEdit ? <EventStatusToggle group="student" event={event} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
