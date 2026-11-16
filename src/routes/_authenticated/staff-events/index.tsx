import { createFileRoute, Link } from "@tanstack/react-router";
import { Panel, EmptyState } from "@/components/attendance-ui";
import { EventForm } from "@/components/EventForm";
import { EventStatusToggle } from "@/components/EventStatusToggle";
import { api } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useRoles } from "@/lib/useAuth";

export const Route = createFileRoute("/_authenticated/staff-events/")({
  component: StaffEvents,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StaffEvents() {
  const { canEdit } = useRoles();
  const list = useQuery({
    queryKey: ["staff-events"],
    queryFn: () => api.staffEvents({ limit: 50 }),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Staff events</h1>
        <p className="text-sm text-muted-foreground">
          Staff events are separate from student events, so a number that appears in both master
          lists is always resolved in the right place.
        </p>
      </header>

      {canEdit ? (
        <Panel
          title="New event"
          description="Fill in the details and press Create. Then open the event to upload its machine files."
        >
          <EventForm group="staff" />
        </Panel>
      ) : null}

      <Panel
        title="Events"
        description="Click an event to open it. Open: files can still be added. Closed: its numbers no longer change. The button on the right closes or reopens it."
      >
        {(list.data ?? []).length === 0 ? (
          <EmptyState title="No events yet">
            {list.isLoading ? "Loading…" : "Create the first staff event above."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-border">
            {(list.data ?? []).map((event) => (
              <li key={event.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div>
                  <Link
                    to="/staff-events/$eventId"
                    params={{ eventId: event.id }}
                    className="font-medium hover:underline"
                  >
                    {event.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {event.event_date} · all staff ·{" "}
                    {event.status === "finalized" ? "closed" : "open"}
                  </p>
                </div>
                {canEdit ? <EventStatusToggle group="staff" event={event} /> : null}
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
