import { useLocation, useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Home, ChevronLeft, ChevronRight } from "lucide-react";
import {
  Breadcrumb,
  BreadcrumbList,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

// Labels by the address shown in the browser. ("_authenticated" is only the
// name of the signed-in layout in the code, never part of an address: linking
// to "/_authenticated/dashboard" is what produced the 404.)
const ROUTE_LABELS: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/students": "Students",
  "/staff": "Staff",
  "/always-present": "Always-present staff",
  "/mass": "Weekly Mass",
  "/mass/weekdays": "Mass department days",
  "/mass/reports": "Weekly Mass reports",
  "/mass/debts": "Mass debts",
  "/reports": "Reports",
  "/reports/students": "Student reports",
  "/reports/staff": "Staff reports",
  "/student-events": "Student events",
  "/staff-events": "Staff events",
  "/import": "Import data",
  "/recurring": "Recurring events",
  "/admin": "Admin settings",
  "/users": "Users & permissions",
  "/sync": "Sync computers",
};

/** A record id in the address (a week, an event): shown as a word, not the id. */
function looksLikeId(segment: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(segment) || /^\d+$/.test(segment);
}

function getRouteSegments(pathname: string): Array<{ label: string; href: string }> {
  const segments = pathname.split("/").filter(Boolean);
  const result: Array<{ label: string; href: string }> = [];
  let currentPath = "";

  for (const segment of segments) {
    const parent = currentPath;
    currentPath += `/${segment}`;
    if (currentPath === "/dashboard") continue; // already the first crumb
    const label =
      ROUTE_LABELS[currentPath] ??
      (looksLikeId(segment)
        ? parent === "/mass"
          ? "Week"
          : parent.endsWith("-events")
            ? "Event"
            : "Details"
        : segment === "reports"
          ? "Report"
          : segment.replace(/-/g, " "));
    result.push({ label, href: currentPath });
  }

  return result;
}

export function PageHeader() {
  const location = useLocation();
  const navigate = useNavigate();
  const segments = getRouteSegments(location.pathname);

  return (
    <div className="flex items-center gap-4">
      <Button
        variant="ghost"
        size="icon"
        onClick={() => window.history.back()}
        aria-label="Go back"
        title="Back"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => void navigate({ to: "/dashboard" })}
        aria-label="Go to dashboard"
        title="Home"
      >
        <Home className="h-4 w-4" />
      </Button>
      <div className="hidden md:block">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/dashboard">Dashboard</BreadcrumbLink>
            </BreadcrumbItem>
            {segments.map((segment, index) => (
              <BreadcrumbItem key={segment.href}>
                <BreadcrumbSeparator />
                {index === segments.length - 1 ? (
                  <BreadcrumbPage>{segment.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink href={segment.href}>{segment.label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            ))}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
    </div>
  );
}
