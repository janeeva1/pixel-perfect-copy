import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, CheckCircle2, FileSpreadsheet, ShieldCheck, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSession } from "@/lib/useAuth";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Attendance Register — Student & Staff Attendance Management" },
      {
        name: "description",
        content:
          "Create attendance sessions, upload biometric machine exports, and get instant present and absent registers for students and staff.",
      },
      { property: "og:title", content: "Attendance Register — Student & Staff Attendance Management" },
      {
        property: "og:description",
        content:
          "Create attendance sessions, upload biometric machine exports, and get instant present and absent registers.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Landing,
});

function Landing() {
  const { session, ready } = useSession();

  return (
    <main className="min-h-screen bg-background">
      <header className="border-b border-border">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-5">
          <span className="font-display text-lg font-semibold">Attendance Register</span>
          {ready && session ? (
            <Button asChild size="sm">
              <Link to="/dashboard">Open dashboard</Link>
            </Button>
          ) : (
            <Button asChild size="sm">
              <Link to="/auth">Sign in</Link>
            </Button>
          )}
        </div>
      </header>

      <section className="mx-auto max-w-5xl px-6 py-20">
        <p className="text-sm font-semibold tracking-widest text-primary uppercase">Institutional attendance</p>
        <h1 className="mt-4 max-w-2xl text-4xl leading-tight font-semibold sm:text-5xl">
          From biometric export to a verified present-and-absent register.
        </h1>
        <p className="mt-5 max-w-xl text-lg text-muted-foreground">
          Keep one master list of students and staff, define exactly who is expected at a session, upload the machine
          file, and let the register work itself out.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Button asChild size="lg">
            <Link to={session ? "/dashboard" : "/auth"}>
              {session ? "Go to dashboard" : "Get started"} <ArrowRight className="ml-2 size-4" />
            </Link>
          </Button>
        </div>

        <div className="mt-16 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { icon: Users, title: "Master list", body: "Students and staff with departments, levels and status." },
            { icon: FileSpreadsheet, title: "Machine upload", body: "Excel or CSV exports read and stored row by row." },
            { icon: CheckCircle2, title: "Automatic register", body: "Present, absent, out of scope and unmatched." },
            { icon: ShieldCheck, title: "Controlled access", body: "Admin, operator and viewer permissions." },
          ].map((item) => (
            <div key={item.title} className="panel p-5">
              <item.icon className="size-5 text-primary" />
              <h3 className="mt-3 font-semibold">{item.title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{item.body}</p>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
