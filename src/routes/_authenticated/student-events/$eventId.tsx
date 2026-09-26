import { createFileRoute, Link } from "@tanstack/react-router";
import { EventResultView } from "@/components/EventResultView";

export const Route = createFileRoute("/_authenticated/student-events/$eventId")({
  component: StudentEventDetail,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function StudentEventDetail() {
  const { eventId } = Route.useParams();
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Link to="/student-events" className="text-sm text-muted-foreground hover:underline">
        ← All student events
      </Link>
      <EventResultView group="student" eventId={eventId} />
    </div>
  );
}
