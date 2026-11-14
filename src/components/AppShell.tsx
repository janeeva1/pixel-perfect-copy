import type { ReactNode } from "react";
import { Link, useNavigate, useLocation } from "@tanstack/react-router";
import { PageHeader } from "@/components/PageHeader";
import {
  BarChart3,
  CalendarCheck,
  CalendarDays,
  ChevronDown,
  Church,
  FileText,
  GraduationCap,
  LayoutDashboard,
  LogOut,
  ShieldCheck,
  Sparkles,
  Users,
  UserCog,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { AppUpdate } from "@/components/AppUpdate";
import { desktopBridge } from "@/lib/electron";
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
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

const nav = [{ to: "/dashboard", label: "Dashboard", icon: LayoutDashboard }] as const;

/**
 * The people the register is about. They sit below Community Mass, which is
 * the weekly job an operator does with them.
 */
const peopleNav = [
  { to: "/students", label: "Students", icon: GraduationCap },
  { to: "/staff", label: "Staff", icon: Users },
] as const;

/**
 * Import Data and Recurring Events are open to anyone who can edit, which is an
 * operator as well as an admin, so they sit outside the admin-only group.
 */
const editorNav = [
  { to: "/import", label: "Import Data", icon: FileText },
  { to: "/recurring", label: "Recurring Events", icon: CalendarDays },
] as const;

const adminNav = [
  { to: "/admin", label: "Admin Settings", icon: ShieldCheck },
  { to: "/users", label: "Users & Permissions", icon: UserCog },
] as const;

/** The class every plain sidebar link uses. */
const LINK_CLASS =
  "flex items-center gap-2 rounded-md px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-sidebar-accent";
/** The same, for a link nested inside a collapsible group. */
const NESTED_LINK_CLASS =
  "flex items-center rounded-md px-3 py-1.5 text-sm whitespace-nowrap transition-colors hover:bg-sidebar-accent";
const ACTIVE_CLASS = "bg-sidebar-accent text-sidebar-accent-foreground";

/**
 * A group of sidebar links that folds away. It opens itself when the page being
 * looked at is inside it, so the group a reader is in is never hidden.
 */
function NavGroup({
  label,
  icon: Icon,
  open,
  children,
}: {
  label: string;
  icon: typeof LayoutDashboard;
  open: boolean;
  children: ReactNode;
}) {
  return (
    <Collapsible defaultOpen={open}>
      <CollapsibleTrigger className={`${LINK_CLASS} w-full justify-between group`}>
        <span className="flex items-center gap-2">
          <Icon className="size-4" />
          {label}
        </span>
        <ChevronDown className="size-4 transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-1 pl-7">{children}</CollapsibleContent>
    </Collapsible>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useSession();
  const { isAdmin, canEdit } = useRoles();
  const { signOut } = useAuthActions();
  // The desktop app's own bridge. It is not there in a browser, and then
  // there is no program to update.
  const bridge = desktopBridge();

  async function handleSignOut() {
    await signOut.mutateAsync();
    navigate({ to: "/auth", replace: true });
  }

  const eventsOpen =
    location.pathname.startsWith("/student-events") ||
    location.pathname.startsWith("/staff-events");
  const reportsOpen =
    location.pathname.startsWith("/reports/students") ||
    location.pathname.startsWith("/reports/staff");
  const massOpen = location.pathname.startsWith("/mass");
  const peopleOpen =
    location.pathname === "/students" ||
    location.pathname.startsWith("/students/") ||
    location.pathname === "/staff" ||
    location.pathname.startsWith("/staff/");

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <div className="flex items-center gap-2 px-3 py-4 border-b border-sidebar-border">
            <img src="/bmx.png" alt="" className="size-7 shrink-0 object-contain" />
            <p className="font-display text-base font-semibold">Attendance Register</p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <nav className="flex flex-col gap-1 p-2">
            {nav.map((item) => (
              <Link
                key={item.to}
                to={item.to}
                activeProps={{ className: ACTIVE_CLASS }}
                className={LINK_CLASS}
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            ))}

            <NavGroup label="Weekly Mass" icon={Church} open={massOpen}>
              <Link
                to="/mass"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Weekly Mass
              </Link>
              <Link
                to="/mass/weekdays"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Mass department days
              </Link>
              <Link
                to="/mass/reports"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Weekly Mass Reports
              </Link>
            </NavGroup>

            <NavGroup label="People" icon={Users} open={peopleOpen}>
              {peopleNav.map((item) => (
                <Link
                  key={item.to}
                  to={item.to}
                  activeProps={{ className: ACTIVE_CLASS }}
                  className={`${NESTED_LINK_CLASS} gap-2`}
                >
                  <item.icon className="size-4" />
                  {item.label}
                </Link>
              ))}
            </NavGroup>

            <NavGroup label="Events" icon={CalendarCheck} open={eventsOpen}>
              <Link
                to="/student-events"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Student events
              </Link>
              <Link
                to="/staff-events"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Staff events
              </Link>
            </NavGroup>

            <NavGroup label="Reports" icon={BarChart3} open={reportsOpen}>
              <Link
                to="/reports/students"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Student reports
              </Link>
              <Link
                to="/reports/staff"
                activeProps={{ className: ACTIVE_CLASS }}
                className={NESTED_LINK_CLASS}
              >
                Staff reports
              </Link>
            </NavGroup>
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
            {bridge ? (
              <Dialog>
                <DialogTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start hover:bg-sidebar-accent"
                  >
                    <Sparkles className="mr-2 size-4" />
                    Update
                    <span className="ml-auto text-xs opacity-70">{bridge.version}</span>
                  </Button>
                </DialogTrigger>
                <DialogContent className="sm:max-w-xl">
                  <DialogHeader>
                    <DialogTitle>Application update</DialogTitle>
                    <DialogDescription>
                      Look for a newer build of the desktop app, download it and restart into it.
                      Your data is not touched.
                    </DialogDescription>
                  </DialogHeader>
                  <AppUpdate compact showFeedUrl={false} />
                </DialogContent>
              </Dialog>
            ) : null}
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
          <header className="sticky top-0 z-40 flex h-14 items-center gap-4 border-b border-border bg-background px-4">
            <SidebarTrigger className="-ml-1" aria-label="Toggle sidebar" />
            <PageHeader />
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
          <main className="relative z-20 flex-1 p-4 lg:p-6">{children}</main>
      </SidebarInset>
    </SidebarProvider>
  );
}
