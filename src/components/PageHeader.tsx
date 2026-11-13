import { useLocation } from "@tanstack/react-router";
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

const ROUTE_LABELS: Record<string, string> = {
  "/_authenticated/dashboard": "Dashboard",
  "/_authenticated/students": "Students",
  "/_authenticated/staff": "Staff",
  "/_authenticated/mass": "Weekly Mass",
  "/_authenticated/mass/weekdays": "Mass Department Days",
  "/_authenticated/mass/reports": "Mass Reports",
  "/_authenticated/mass/$weekId": "Mass Week",
  "/_authenticated/mass/$weekId/reports": "Mass Week Reports",
  "/_authenticated/reports/students": "Student Reports",
  "/_authenticated/reports/staff": "Staff Reports",
  "/_authenticated/student-events": "Student Events",
  "/_authenticated/staff-events": "Staff Events",
  "/_authenticated/import": "Import Data",
  "/_authenticated/recurring": "Recurring Events",
  "/_authenticated/admin": "Admin Settings",
  "/_authenticated/users": "Users & Permissions",
};

function getRouteSegments(pathname: string): Array<{ label: string; href: string }> {
  const segments = pathname.split("/").filter(Boolean);
  const result: Array<{ label: string; href: string }> = [];
  let currentPath = "";

  for (const segment of segments) {
    currentPath += `/${segment}`;
    const label = ROUTE_LABELS[currentPath] ?? segment.replace(/^\$/, "").replace(/-/g, " ");
    result.push({ label, href: currentPath });
  }

  return result;
}

export function PageHeader() {
  const location = useLocation();
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
        onClick={() => (window.location.href = "/_authenticated/dashboard")}
        aria-label="Go to dashboard"
        title="Home"
      >
        <Home className="h-4 w-4" />
      </Button>
      <div className="hidden md:block">
        <Breadcrumb>
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink href="/_authenticated/dashboard">Dashboard</BreadcrumbLink>
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
