import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { DataRow, DataTable, EmptyState, Panel } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import type { ReviewPerson } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/always-present")({
  component: AlwaysPresentPage,
});

const ROLES = [
  "Vice-Chancellor",
  "Deputy Vice-Chancellor",
  "Provost",
  "Registrar",
  "Bursar",
  "University Librarian",
  "Dean",
  "Chaplain",
];

/**
 * Staff who are never counted absent: the Vice-Chancellor, DVCs, the Provost
 * and others the university excuses. Each is shown present at every staff event
 * and every staff Weekly Mass that has an upload, and is never charged on the
 * debt page. Removing someone puts them back on the ordinary rules, for past
 * weeks as well (nothing is stored per week).
 */
function AlwaysPresentPage() {
  const queryClient = useQueryClient();
  const { isAdmin } = useRoles();
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ReviewPerson | null>(null);
  const [reason, setReason] = useState("");

  const list = useQuery({ queryKey: ["always-present"], queryFn: api.alwaysPresent.list });
  const found = useQuery({
    queryKey: ["review-search", "staff", text],
    queryFn: () => api.review.search("staff", text),
    enabled: text.trim().length >= 2 && picked === null,
  });

  const refresh = () => {
    void queryClient.invalidateQueries();
  };
  const add = useMutation({
    mutationFn: () => {
      const number = picked?.machine || picked?.code || "";
      return api.alwaysPresent.add({ staffNo: number, reason: reason.trim() });
    },
    onSuccess: (row) => {
      toast.success(`${row.name ?? row.scanNumber} is now always present.`);
      setPicked(null);
      setText("");
      setReason("");
      refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const remove = useMutation({
    mutationFn: (scanNumber: string) => api.alwaysPresent.remove(scanNumber),
    onSuccess: () => {
      toast.success("Removed. They are counted like everyone else again.");
      refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  // One row per number (a number can resolve to a person's two records).
  const rows = [...new Map((list.data ?? []).map((row) => [row.scanNumber, row])).values()];

  return (
    <div className="space-y-6">
      <Panel
        title="Always-present staff"
        description="Staff on this list (Vice-Chancellor, DVCs, Provost and so on) are shown present at every staff event and every staff Weekly Mass that has an upload. They are never absent and never owe on the debt page."
      >
        {isAdmin ? (
          <div className="space-y-3">
            {picked ? (
              <div className="flex flex-wrap items-end gap-3 rounded-md border p-3">
                <div>
                  <p className="font-medium">{picked.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {[
                      picked.code,
                      picked.machine ? `machine ${picked.machine}` : null,
                      picked.department,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                <div className="space-y-1">
                  <Label htmlFor="reason">Office / reason</Label>
                  <Input
                    id="reason"
                    list="always-present-roles"
                    className="w-64"
                    placeholder="e.g. Vice-Chancellor"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  />
                  <datalist id="always-present-roles">
                    {ROLES.map((role) => (
                      <option key={role} value={role} />
                    ))}
                  </datalist>
                </div>
                <Button disabled={add.isPending} onClick={() => add.mutate()}>
                  {add.isPending ? "Adding…" : "Add to the list"}
                </Button>
                <Button variant="ghost" onClick={() => setPicked(null)}>
                  Cancel
                </Button>
              </div>
            ) : (
              <>
                <div className="relative max-w-md">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input
                    className="pl-8"
                    placeholder="Find a staff member by name or staff number"
                    value={text}
                    onChange={(event) => setText(event.target.value)}
                  />
                </div>
                {found.data && found.data.length > 0 ? (
                  <ul className="max-w-2xl space-y-1">
                    {found.data.map((person) => (
                      <li key={person.id}>
                        <button
                          type="button"
                          className="w-full rounded-md border p-2 text-left hover:bg-muted/50"
                          onClick={() => setPicked(person)}
                        >
                          <span className="block font-medium">{person.name}</span>
                          <span className="block text-sm text-muted-foreground">
                            {[person.code, person.department].filter(Boolean).join(" · ")}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : text.trim().length >= 2 && found.isFetched ? (
                  <p className="text-sm text-muted-foreground">Nobody found.</p>
                ) : null}
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only an administrator can change this list.
          </p>
        )}
      </Panel>

      {list.isError ? (
        <p role="alert" className="text-sm text-rose-600">
          {(list.error as Error).message}
        </p>
      ) : !list.data ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState title="Nobody is on the list yet" />
      ) : (
        <DataTable
          head={[
            "Name",
            "Staff number",
            "Machine number",
            "Department / unit",
            "Office / reason",
            "",
          ]}
        >
          {rows.map((row) => (
            <DataRow
              key={row.scanNumber}
              cells={[
                row.name ?? <span className="text-muted-foreground">Nobody has this number</span>,
                <span className="font-mono text-xs">{row.staffNo ?? "—"}</span>,
                <span className="font-mono text-xs">{row.scanNumber}</span>,
                row.department ?? "—",
                <span>
                  {row.reason || "—"}{" "}
                  {row.isBuiltin ? <Badge variant="outline">built in</Badge> : null}
                </span>,
                isAdmin && !row.isBuiltin ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`Remove ${row.name ?? row.scanNumber} from the list?`)) {
                        remove.mutate(row.scanNumber);
                      }
                    }}
                  >
                    <Trash2 className="mr-1 h-4 w-4" /> Remove
                  </Button>
                ) : null,
              ]}
            />
          ))}
        </DataTable>
      )}
    </div>
  );
}
