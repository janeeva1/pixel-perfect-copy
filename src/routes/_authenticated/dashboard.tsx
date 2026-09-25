import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useRoles } from "@/lib/useAuth";

export const Route = createFileRoute("/_authenticated/dashboard")({
  head: () => ({
    meta: [
      { title: "Dashboard — Attendance Register" },
      { name: "description", content: "Overview of students, staff and recent attendance sessions." },
      { property: "og:title", content: "Dashboard — Attendance Register" },
      { property: "og:description", content: "Overview of students, staff and recent attendance sessions." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Dashboard,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function Dashboard() {
  const { canEdit } = useRoles();

  const stats = useQuery({
    queryKey: ["dashboard-stats"],
    queryFn: async () => {
      const [students, staff, sessions] = await Promise.all([
        supabase
          .from("people")
          .select("id", { count: "exact", head: true })
          .eq("person_type", "student")
          .is("deleted_at", null),
        supabase
          .from("people")
          .select("id", { count: "exact", head: true })
          .eq("person_type", "staff")
          .is("deleted_at", null),
        supabase.from("attendance_sessions").select("id", { count: "exact", head: true }),
      ]);
      return {
        students: students.count ?? 0,
        staff: staff.count ?? 0,
        sessions: sessions.count ?? 0,
      };
    },
  });

  const recent = useQuery({
    queryKey: ["recent-sessions"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("attendance_sessions")
        .select("id, title, session_date, person_type, status")
        .order("created_at", { ascending: false })
        .limit(6);
      if (error) throw error;
      return data ?? [];
    },
  });

  return (
    <div className="mx-auto max-w-5xl space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Master records and recent attendance sessions.</p>
        </div>
        {canEdit && (
          <Button asChild>
            <Link to="/sessions">New session</Link>
          </Button>
        )}
      </header>

      <div className="grid gap-4 sm:grid-cols-3">
        {[
          { label: "Students", value: stats.data?.students },
          { label: "Staff", value: stats.data?.staff },
          { label: "Sessions", value: stats.data?.sessions },
        ].map((card) => (
          <div key={card.label} className="panel p-5">
            <p className="text-sm text-muted-foreground">{card.label}</p>
            <p className="mt-2 font-display text-3xl font-semibold">{card.value ?? "—"}</p>
          </div>
        ))}
      </div>

      <section className="panel p-5">
        <h2 className="text-lg font-semibold">Recent sessions</h2>
        {recent.data && recent.data.length > 0 ? (
          <ul className="mt-4 divide-y divide-border">
            {recent.data.map((session) => (
              <li key={session.id} className="flex items-center justify-between py-3">
                <div>
                  <Link to="/sessions/$sessionId" params={{ sessionId: session.id }} className="font-medium hover:underline">
                    {session.title}
                  </Link>
                  <p className="text-xs text-muted-foreground">
                    {session.session_date} · {session.person_type} · {session.status}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">
            No sessions yet. Import your master records, then create your first session.
          </p>
        )}
      </section>

      {!stats.data?.students && !stats.data?.staff && (
        <div className="panel border-accent/60 p-5">
          <h2 className="font-semibold">Start by importing your records</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload your student and staff files once. Everything else works from that master list.
          </p>
          <Button asChild variant="outline" className="mt-4">
            <Link to="/people">Import students & staff</Link>
          </Button>
        </div>
      )}
    </div>
  );
}
