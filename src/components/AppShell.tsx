import type { ReactNode } from "react";
import { Link, useNavigate, useLocation } from "@tanstack/react-router";
import {
  BarChart3,
  CalendarCheck,
  CalendarDays,
  FileText,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Users,
  UserCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuthActions, useRoles, useSession } from "@/lib/useAuth";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

const nav = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/students", label: "Students", icon: GraduationCap },
  { to: "/staff", label: "Staff", icon: Users },
  { to: "/student-events", label: "Student events", icon: CalendarCheck },
  { to: "/staff-events", label: "Staff events", icon: CalendarCheck },
  { to: "/reports/students", label: "Student reports", icon: BarChart3 },
  { to: "/reports/staff", label: "Staff reports", icon: BarChart3 },
] as const;

/**
 * Import Data and Recurring Events are open to anyone who can edit, which is an
 * operator as well as an admin, so they sit outside the admin-only group. They
 * used to live in it, which left the pages reachable but undiscoverable to an
 * operator who was allowed to use them.
 */
const editorNav = [
  { to: "/import", label: "Import Data", icon: FileText },
  { to: "/recurring", label: "Recurring Events", icon: CalendarDays },
] as const;

const adminNav = [
  { to: "/admin", label: "Admin Settings", icon: ShieldCheck },
  { to: "/users", label: "Users & Permissions", icon: UserCog },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  const { isAdmin, canEdit } = useRoles();
  const { signOut } = useAuthActions();

  async function handleSignOut() {
    await signOut.mutateAsync();
    navigate({ to: "/auth", replace: true });
  }

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-3 py-4 border-b border-sidebar-border">
            <LayoutDashboard className="size-6 text-primary" />
            <p className="font-display text-base font-semibold">Attendance Register</p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <nav className="flex flex-col gap-1 p-2">
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
          </nav>
          {canEdit ? (
            <>
              <Separator className="mx-2 my-4" />
              <nav className="flex flex-col gap-1 px-2">
                {editorNav.map((item) => (
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
              </nav>
            </>
          ) : null}
          {isAdmin && (
            <>
              <Separator className="mx-2 my-4" />
              <nav className="flex flex-col gap-1 px-2">
                {adminNav.map((item) => (
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
              </nav>
            </>
          )}
        </SidebarContent>
        <SidebarFooter>
          <div className="border-t border-sidebar-border p-3">
            <p className="truncate px-3 pb-2 text-xs opacity-70">{user?.email}</p>
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start hover:bg-sidebar-accent"
              onClick={handleSignOut}
              disabled={signOut.isPending}
            >
              <LogOut className="mr-2 size-4" /> Sign out
            </Button>
          </div>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset>
        <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 px-4">
          <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
          <div className="flex-1" />
          <div className="flex items-center gap-4 text-sm">
            <span className="text-muted-foreground hidden sm:block">
              {user?.fullName ?? user?.email}
            </span>
            <Button variant="ghost" size="sm" onClick={handleSignOut} disabled={signOut.isPending}>
              <LogOut className="mr-2 size-4" /> Sign out
            </Button>
          </div>
        </header>
        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
