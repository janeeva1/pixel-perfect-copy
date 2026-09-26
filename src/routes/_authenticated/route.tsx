import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { api } from "@/lib/api";
import { AppShell } from "@/components/AppShell";

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  beforeLoad: async () => {
    const me = await api.me();
    if (!me) throw redirect({ to: "/auth" });
    // Children read roles from here. beforeLoad runs outside React, so it must
    // never call a hook; it takes the session this guard already fetched.
    return { me };
  },
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
});
