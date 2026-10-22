import { createFileRoute, redirect } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataTable, DataRow, EmptyState, Panel } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { MASS_WEEKDAY_LABELS, type MassWeekdayAssignment } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/mass/weekdays")({
  beforeLoad: ({ context }) => {
    // Saving an assignment needs edit rights, so the page does too: a viewer
    // would only ever see failed saves.
    if (!context.me.roles.includes("admin") && !context.me.roles.includes("operator")) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: MassWeekdaysPage,
});

const DAY_OPTIONS = [1, 2, 3, 4, 5].map((day) => ({
  value: String(day),
  label: MASS_WEEKDAY_LABELS[day] ?? String(day),
}));

/**
 * One-time, lifetime configuration: which weekday each department's Community
 * Mass falls on. It is edited in place rather than versioned, because a
 * department has exactly one weekday and re-assigning simply moves it.
 */
function MassWeekdaysPage() {
  const queryClient = useQueryClient();
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedDay, setSelectedDay] = useState("1");
  const [activeMap, setActiveMap] = useState<Record<string, boolean>>({});

  const assignments = useQuery({
    queryKey: ["mass-weekdays"],
    queryFn: api.mass.weekdays,
  });

  const departments = useQuery({
    queryKey: ["departments"],
    queryFn: api.departments,
  });

  const staffDepartments = useQuery({
    queryKey: ["staff-departments"],
    queryFn: api.staffDepartments,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["mass-weekdays"] });

  const save = useMutation({
    mutationFn: () => api.mass.setWeekday(selectedDepartment, Number(selectedDay)),
    onSuccess: () => {
      toast.success("Assignment saved");
      setSelectedDepartment("");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const toggleActive = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      api.mass.updateWeekday(id, isActive),
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.mass.deleteWeekday(id),
    onSuccess: () => {
      toast.success("Assignment removed");
      invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

  const rows = assignments.data?.assignments ?? [];
  const assignedCodes = new Set(rows.map((row) => row.department_code.trim().toLowerCase()));

  // Both the student and the staff names, deduped case-insensitively and sorted,
  // so the picker offers every department either file can hold.
  const allDepartments: string[] = [];
  const seen = new Set<string>();
  for (const name of [
    ...(departments.data ?? []),
    ...(staffDepartments.data?.departments.map((option) => option.department) ?? []),
  ]) {
    const key = name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    allDepartments.push(name);
  }
  allDepartments.sort((a, b) => a.localeCompare(b));
  const unassigned = allDepartments.filter((name) => !assignedCodes.has(name.trim().toLowerCase()));

  function handleToggle(row: MassWeekdayAssignment, checked: boolean) {
    setActiveMap((prev) => ({ ...prev, [row.id]: checked }));
    toggleActive.mutate({ id: row.id, isActive: checked });
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Department → weekday assignment"
        description="Set which weekday each department's Community Mass falls on. A department can only hold one weekday; re-assigning simply moves it."
      >
        <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="space-y-2">
            <Label htmlFor="department">Department</Label>
            <Select value={selectedDepartment} onValueChange={setSelectedDepartment}>
              <SelectTrigger id="department" className="w-full">
                <SelectValue placeholder="Pick a department" />
              </SelectTrigger>
              <SelectContent>
                {unassigned.length === 0 ? (
                  <p className="px-3 py-2 text-sm text-muted-foreground">
                    Every department already has a weekday.
                  </p>
                ) : (
                  unassigned.map((code) => (
                    <SelectItem key={code} value={code}>
                      {code}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="day">Weekday</Label>
            <Select value={selectedDay} onValueChange={setSelectedDay}>
              <SelectTrigger id="day" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAY_OPTIONS.map((day) => (
                  <SelectItem key={day.value} value={day.value}>
                    {day.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button disabled={!selectedDepartment || save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </div>
        {unassigned.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            Every department already has a weekday assigned.
          </p>
        ) : null}
      </Panel>

      <Panel
        title="Current assignments"
        description="Switch a department off to stop expecting it at new weeks without forgetting its weekday."
      >
        {rows.length === 0 ? (
          <EmptyState title="No departments assigned yet">
            Assign each department a weekday above.
          </EmptyState>
        ) : (
          <DataTable head={["Department", "Weekday", "Active", ""]}>
            {rows.map((row) => (
              <DataRow
                key={row.id}
                cells={[
                  <span className="text-xs text-muted-foreground">{row.department_code}</span>,
                  MASS_WEEKDAY_LABELS[row.day_of_week] ?? String(row.day_of_week),
                  <span className="flex items-center gap-2">
                    <Checkbox
                      id={`active-${row.id}`}
                      checked={activeMap[row.id] ?? row.is_active}
                      onCheckedChange={(checked) => handleToggle(row, checked === true)}
                    />
                    <Label htmlFor={`active-${row.id}`} className="text-sm">
                      {(activeMap[row.id] ?? row.is_active) ? "Active" : "Inactive"}
                    </Label>
                  </span>,
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-rose-600"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(row.id)}
                  >
                    Remove
                  </Button>,
                ]}
              />
            ))}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
