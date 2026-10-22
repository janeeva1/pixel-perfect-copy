import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { useSession } from "@/lib/useAuth";
import type { AppRole } from "@/lib/types";

const ROLES: AppRole[] = ["admin", "operator", "viewer"];

const ROLE_NOTES: Record<AppRole, string> = {
  admin: "Can manage users and change records.",
  operator: "Can create sessions and import records.",
  viewer: "Read-only access.",
};

export const Route = createFileRoute("/_authenticated/users")({
  head: () => ({
    meta: [
      { title: "Permissions — Attendance Register" },
      { name: "description", content: "Give each member of staff the right level of access." },
    ],
  }),
  // The sidebar hides this link from anyone who is not an administrator, and the
  // API refuses a non-admin anyway. Guard the page itself as well so typing the
  // URL does not reveal that user management exists.
  beforeLoad: ({ context }) => {
    if (!context.me.roles.includes("admin")) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: UsersPage,
  errorComponent: ({ error }) => <p role="alert">{error.message}</p>,
});

function UsersPage() {
  const { user } = useSession();
  const queryClient = useQueryClient();
  const users = useQuery({ queryKey: ["users"], queryFn: api.users });

  const changeRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: AppRole }) =>
      api.setUserRole(userId, role),
    onSuccess: () => {
      toast.success("Role updated.");
      queryClient.invalidateQueries({ queryKey: ["users"] });
      queryClient.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (error) =>
      toast.error(error instanceof Error ? error.message : "Could not change that role"),
  });

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-semibold">Permissions</h1>
        <p className="text-sm text-muted-foreground">
          Everyone who can sign in, and what they are allowed to do. The first account created is
          the administrator.
        </p>
      </header>

      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/60 text-left text-xs tracking-wide text-muted-foreground uppercase">
              <tr>
                <th className="p-3">Account</th>
                <th className="p-3">Name</th>
                <th className="p-3">Role</th>
                <th className="p-3">Created</th>
              </tr>
            </thead>
            <tbody>
              {users.isLoading && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">
                    Loading…
                  </td>
                </tr>
              )}
              {users.data?.users.map((row) => {
                const role = row.roles[0] ?? "viewer";
                const isSelf = row.id === user?.id;
                return (
                  <tr key={row.id} className="border-t border-border">
                    <td className="p-3 font-medium">
                      {row.email}
                      {isSelf && <span className="ml-2 text-xs text-muted-foreground">(you)</span>}
                    </td>
                    <td className="p-3 text-muted-foreground">{row.fullName || "—"}</td>
                    <td className="p-3">
                      <Select
                        value={role}
                        disabled={changeRole.isPending}
                        onValueChange={(value) =>
                          changeRole.mutate({ userId: row.id, role: value as AppRole })
                        }
                      >
                        <SelectTrigger className="w-40" aria-label={`Role for ${row.email}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ROLES.map((option) => (
                            <SelectItem key={option} value={option}>
                              {option}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {changeRole.isPending ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        new Date(row.createdAt).toLocaleDateString()
                      )}
                    </td>
                  </tr>
                );
              })}
              {users.data?.users.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted-foreground">
                    No accounts yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="border-t border-border p-3 text-xs text-muted-foreground">
          {ROLES.map((role) => `${role}: ${ROLE_NOTES[role]}`).join("  ·  ")}
        </p>
      </section>
    </div>
  );
}
