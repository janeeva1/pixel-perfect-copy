import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  useLocation,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";
import { Toaster } from "sonner";
import { api } from "@/lib/api";

import "../global-error-handler";
import appCss from "../styles.css?url";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error("ROOT ERROR BOUNDARY:", error);
  console.error("Stack:", error.stack);

  const router = useRouter();

  // Try to get more context about the error
  const errorInfo = error.message || "Unknown error";
  const errorStack = error.stack || "No stack trace";

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Page Error</h1>
        <p className="mt-2 text-sm text-muted-foreground">{errorInfo}</p>
        <pre className="mt-4 p-3 text-xs text-red-600 bg-red-50 rounded overflow-auto text-left max-h-64 overflow-y-auto">
          {errorStack}
        </pre>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Attendance Register" },
      { name: "description", content: "Student and staff attendance management" },
      { property: "og:title", content: "Attendance Register" },
      { property: "og:description", content: "Student and staff attendance management" },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      { rel: "icon", href: "/favicon.ico", type: "image/x-icon" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
      <SetupGuard />
      <Outlet />
      <Toaster
        position="top-right"
        toastOptions={{ className: "bg-background text-foreground border-border" }}
      />
    </QueryClientProvider>
  );
}

function SetupGuard() {
  const { data, isLoading } = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => api.setupStatus(),
    retry: false,
    refetchOnWindowFocus: false,
  });

  const router = useRouter();
  const location = useLocation();

  useEffect(() => {
    if (
      !isLoading &&
      data?.complete === false &&
      location.pathname !== "/setup" &&
      location.pathname !== "/auth"
    ) {
      void router.navigate({ to: "/setup", replace: true });
    }
  }, [isLoading, data?.complete, location.pathname, router]);

  return null;
}
