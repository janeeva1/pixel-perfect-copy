import { createFileRoute, Link } from "@tanstack/react-router";
import { EventResultView } from "@/components/EventResultView";

export const Route = createFileRoute("/_authenticated/staff-events/$eventId")({
  component: StaffEventDetail,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StaffEventDetail() {
  const { eventId } = Route.useParams();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/staff-events" className="text-sm text-muted-foreground hover:underline">
        ← All staff events
      </Link>
      <EventResultView group="staff" eventId={eventId} />
    </div>
  );
}
