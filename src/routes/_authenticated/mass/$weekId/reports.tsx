import { createFileRoute } from "@tanstack/react-router";
import { MassWeekReport } from "@/components/MassWeekReport";

export const Route = createFileRoute("/_authenticated/mass/$weekId/reports")({
  component: MassWeekReportsPage,
});

/** The week's report on a page of its own (the same report is under the uploads). */
function MassWeekReportsPage() {
  const { weekId } = Route.useParams();
  return <MassWeekReport weekId={weekId} />;
}
