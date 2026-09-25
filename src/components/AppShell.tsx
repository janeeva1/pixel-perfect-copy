import type { ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { CalendarCheck, LayoutDashboard, LogOut, ShieldCheck, Users } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useRoles, useSession } from "@/lib/useAuth";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/people", label: "Students & staff", icon: Users },
  { to: "/sessions", label: "Sessions", icon: CalendarCheck },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user } = useSession();
  const { isAdmin, roles } = useRoles();

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <div className="flex min-h-screen flex-col bg-background lg:flex-row">
      <aside className="flex flex-col bg-sidebar text-sidebar-foreground lg:w-64">
        <div className="border-b border-sidebar-border px-6 py-5">
          <p className="font-display text-base font-semibold">Attendance Register</p>
          <p className="mt-1 text-xs opacity-70">{roles.join(", ") || "no role yet"}</p>
        </div>
        <nav className="flex flex-1 flex-row gap-1 overflow-x-auto p-3 lg:flex-col">
          {nav.map((item) => (
            <Link
              key={item.to}
              to={item.to}
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-sidebar-accent"
            >
              <item.icon className="size-4" />
              {item.label}
            </Link>
          ))}
          {isAdmin && (
            <Link
              to="/users"
              activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground" }}
              className="flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-sidebar-accent"
            >
              <ShieldCheck className="size-4" />
              Permissions
            </Link>
          )}
        </nav>
        <div className="border-t border-sidebar-border p-3">
          <p className="truncate px-3 pb-2 text-xs opacity-70">{user?.email}</p>
          <Button variant="ghost" size="sm" className="w-full justify-start hover:bg-sidebar-accent" onClick={signOut}>
            <LogOut className="mr-2 size-4" /> Sign out
          </Button>
        </div>
      </aside>
      <main className="flex-1 px-5 py-8 lg:px-10">{children}</main>
    </div>
  );
}
