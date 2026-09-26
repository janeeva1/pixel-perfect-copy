import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DataRow, DataTable, EmptyState, Panel, StatTile } from "@/components/attendance-ui";
import { DepartmentMultiSelect } from "@/components/DepartmentMultiSelect";
import { api } from "@/lib/api";
import type { EventCategory, GroupKind, StudentCategory } from "@/lib/types";
import { useRoles } from "@/lib/useAuth";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/recurring")({
  beforeLoad: ({ context }) => {
    const roles = context.me.roles;
    if (!roles.includes("admin") && !roles.includes("operator")) {
      throw redirect({ to: "/dashboard" });
    }
  },
  component: RecurringPage,
});

/**
 * A template covers one day of the week, so Monday's event is a template of its
 * own and can be edited without touching Wednesday's. Saturday is left out
 * because nothing is held on it.
 */
const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 0, label: "Sunday" },
];

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const CATEGORIES = [
  { value: "undergraduate", label: "Undergraduate" },
  { value: "postgraduate", label: "Postgraduate" },
];

type DaySchedule = {
  day: number;
  category: StudentCategory | null;
  level: string | null;
  departments: string[];
  suffix: string | null;
};

const BLANK_DAY: DaySchedule = {
  day: 1,
  category: null,
  level: null,
  departments: [],
  suffix: null,
};

function RecurringPage() {
  const queryClient = useQueryClient();
  const { canEdit } = useRoles();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<DaySchedule>(BLANK_DAY);
  const [groupKind, setGroupKind] = useState<GroupKind>("student");
  // Generated events inherit this, so a Community Mass template produces
  // Community Mass events without anyone re-marking each one.
  const [eventCategory, setEventCategory] = useState<EventCategory>("other");

  const templates = useQuery({
    queryKey: ["recurring-templates"],
    queryFn: () => api.recurring.list(),
  });

  const studentDepartmentOptions = useQuery({
    queryKey: ["departments"],
    queryFn: () => api.departments(),
  });

  const staffDepartmentOptions = useQuery({
    queryKey: ["staff-departments"],
    queryFn: () => api.staffDepartments(),
  });

  // Staff have no level or undergraduate/postgraduate split, so the list is
  // only asked for when a student template is being written.
  const levelOptions = useQuery({
    queryKey: ["levels"],
    queryFn: () => api.levels(),
    enabled: groupKind === "student",
  });

  const departmentChoices = useMemo(
    () =>
      groupKind === "student"
        ? (studentDepartmentOptions.data ?? []).map((code) => ({ value: code, label: code }))
        : (staffDepartmentOptions.data?.departments ?? []).map((option) => ({
            value: option.department,
            label: option.department,
            count: option.total,
          })),
    [groupKind, studentDepartmentOptions.data, staffDepartmentOptions.data],
  );

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api.recurring.delete(id),
    onSuccess: () => {
      toast.success("Template deleted");
      queryClient.invalidateQueries({ queryKey: ["recurring-templates"] });
    },
    onError: (e) => toast.error(e.message),
  });

  const generateEvents = useMutation({
    mutationFn: (id: string) => api.recurring.generate(id),
    onSuccess: (data) => {
      toast.success(`Generated ${data.created} events (${data.skipped} skipped)`);
      queryClient.invalidateQueries({ queryKey: ["recurring-templates"] });
    },
    onError: (e) => toast.error(e.message),
  });

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    // The day, category, level and departments are held in state rather than in
    // the form, because a picker and a multi-select have no form value to read.
    const schedules = [
      {
        day_of_week: schedule.day,
        student_category: groupKind === "student" ? schedule.category : null,
        level: groupKind === "student" ? schedule.level : null,
        departments: schedule.departments,
        title_suffix: schedule.suffix,
      },
    ];

    const payload = {
      name: formData.get("name") as string,
      description: (formData.get("description") as string) || null,
      start_date: formData.get("start_date") as string,
      end_date: formData.get("end_date") as string,
      event_title_template: formData.get("event_title_template") as string,
      start_time: (formData.get("start_time") as string) || null,
      end_time: (formData.get("end_time") as string) || null,
      notes: (formData.get("notes") as string) || null,
      group_kind: groupKind,
      event_category: eventCategory,
      schedules,
    };

    try {
      if (editing) {
        await api.recurring.update(editing, payload);
        toast.success("Template updated");
      } else {
        await api.recurring.create(payload);
        toast.success("Template created");
      }
      setShowForm(false);
      setEditing(null);
      setSchedule(BLANK_DAY);
      queryClient.invalidateQueries({ queryKey: ["recurring-templates"] });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save");
    }
  };
  const handleGenerate = async (id: string) => {
    if (
      !confirm(
        "Generate all events for this template's date range? Existing events for these dates will be skipped.",
      )
    )
      return;
    await generateEvents.mutateAsync(id);
  };

  const setDay = (patch: Partial<DaySchedule>) =>
    setSchedule((current) => ({ ...current, ...patch }));

  /** Load a template into the form, including its group, day and departments. */
  const startEditing = (id: string) => {
    const template = templates.data?.find((item) => item.id === id);
    if (!template) return;
    const first = template.schedules[0];
    setEditing(id);
    setGroupKind(template.group_kind);
    setEventCategory(template.event_category ?? "other");
    setSchedule({
      day: first?.day_of_week ?? 1,
      category: first?.student_category ?? null,
      level: first?.level ?? null,
      departments: first?.departments ?? [],
      suffix: first?.title_suffix ?? null,
    });
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditing(null);
    setSchedule(BLANK_DAY);
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Recurring Event Templates</h1>
          <p className="text-sm text-muted-foreground">
            One template is one day of the week, for students or for staff, so each day can be
            changed on its own. Generate the events for a semester date range in one click.
          </p>
        </div>
        <Button
          onClick={() => {
            setEditing(null);
            setGroupKind("student");
            setSchedule(BLANK_DAY);
            setShowForm(true);
          }}
        >
          + New Template
        </Button>
      </header>

      {showForm && (
        <Panel title={editing ? "Edit Template" : "New Template"}>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label>Who is this for?</Label>
                <Select
                  value={groupKind}
                  onValueChange={(value) => {
                    setGroupKind(value as GroupKind);
                    // Category and level are a student-only split, and the
                    // departments are codes for one group and names for the
                    // other, so changing the group clears the scope rather than
                    // keeping one that would quietly match nobody.
                    setSchedule(BLANK_DAY);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="student">Students</SelectItem>
                    <SelectItem value="staff">Staff</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="day">Day of the week</Label>
                <Select
                  value={String(schedule.day)}
                  onValueChange={(value) => setDay({ day: parseInt(value) })}
                >
                  <SelectTrigger id="day">
                    <SelectValue placeholder="Select a day" />
                  </SelectTrigger>
                  <SelectContent>
                    {DAYS.map((day) => (
                      <SelectItem key={day.value} value={String(day.value)}>
                        {day.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="event_category">Event type</Label>
                <Select
                  value={eventCategory}
                  onValueChange={(value) => setEventCategory(value as EventCategory)}
                >
                  <SelectTrigger id="event_category">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="other">Other Events</SelectItem>
                    <SelectItem value="community_mass">Community Mass</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Every event generated from this template gets this type.
                </p>
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  name="name"
                  required
                  placeholder="e.g. Community Mass 2026"
                  defaultValue={editing ? templates.data?.find((t) => t.id === editing)?.name : ""}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="event_title_template">Event Title Template</Label>
                <Input
                  id="event_title_template"
                  name="event_title_template"
                  required
                  placeholder="e.g. Community Mass"
                  defaultValue={
                    editing
                      ? templates.data?.find((t) => t.id === editing)?.event_title_template
                      : ""
                  }
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Input
                id="description"
                name="description"
                placeholder="Optional description"
                defaultValue={
                  editing ? templates.data?.find((t) => t.id === editing)?.description || "" : ""
                }
              />
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="start_date">Start Date</Label>
                <Input
                  id="start_date"
                  name="start_date"
                  type="date"
                  required
                  defaultValue={
                    editing ? templates.data?.find((t) => t.id === editing)?.start_date : ""
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end_date">End Date</Label>
                <Input
                  id="end_date"
                  name="end_date"
                  type="date"
                  required
                  defaultValue={
                    editing ? templates.data?.find((t) => t.id === editing)?.end_date : ""
                  }
                />
              </div>
            </div>
            <div className="grid gap-4 md:grid-cols-4">
              <div className="space-y-2">
                <Label htmlFor="start_time">Start Time</Label>
                <Input
                  id="start_time"
                  name="start_time"
                  type="time"
                  defaultValue={
                    editing ? templates.data?.find((t) => t.id === editing)?.start_time || "" : ""
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="end_time">End Time</Label>
                <Input
                  id="end_time"
                  name="end_time"
                  type="time"
                  defaultValue={
                    editing ? templates.data?.find((t) => t.id === editing)?.end_time || "" : ""
                  }
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="notes">Notes</Label>
                <Input
                  id="notes"
                  name="notes"
                  placeholder="Optional notes"
                  defaultValue={
                    editing ? templates.data?.find((t) => t.id === editing)?.notes || "" : ""
                  }
                />
              </div>
            </div>

            <hr className="my-4 border-border" />
            <h3 className="font-medium">Who is expected</h3>
            <p className="text-sm text-muted-foreground">
              Narrow the {DAYS.find((d) => d.value === schedule.day)?.label.toLowerCase() ?? "day"}{" "}
              event to a category, a level and any departments, or leave everything alone to expect
              everybody. Choosing several departments makes one event covering all of them.
            </p>

            {groupKind === "student" ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <Label>Category</Label>
                  <Select
                    value={schedule.category ?? "all"}
                    onValueChange={(value) =>
                      setDay({ category: value === "all" ? null : (value as StudentCategory) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All students</SelectItem>
                      {CATEGORIES.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Level</Label>
                  <Select
                    value={schedule.level ?? "all"}
                    onValueChange={(value) => setDay({ level: value === "all" ? null : value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All levels</SelectItem>
                      {(levelOptions.data ?? []).map((level) => (
                        <SelectItem key={level} value={level}>
                          Level {level}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            ) : null}

            <div className="space-y-2">
              <DepartmentMultiSelect
                id="template-departments"
                label="Departments"
                emptyLabel={groupKind === "student" ? "All departments" : "All staff"}
                options={departmentChoices}
                value={schedule.departments}
                onChange={(departments) => setDay({ departments })}
                hint={
                  groupKind === "student"
                    ? "The department codes worked out from the students' matric numbers."
                    : "Taken from the staff file, preferring the department they administer and falling back to the one listed beside them."
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="suffix">Title Suffix</Label>
              <Input
                id="suffix"
                value={schedule.suffix ?? ""}
                onChange={(event) => setDay({ suffix: event.target.value || null })}
                placeholder="e.g. CSC Mass"
              />
            </div>

            <div className="flex justify-end gap-2 pt-4 border-t">
              <Button type="button" variant="outline" onClick={closeForm}>
                Cancel
              </Button>
              <Button type="submit">{editing ? "Update" : "Create"}</Button>
            </div>
          </form>
        </Panel>
      )}

      <Panel title="Templates">
        <p className="text-sm text-muted-foreground mb-4">
          {templates.data?.length ?? 0} template(s)
        </p>
        {templates.isLoading ? (
          <EmptyState title="Loading templates..." />
        ) : templates.data?.length === 0 ? (
          <EmptyState title="No templates yet" />
        ) : (
          <DataTable
            head={["Name", "For", "Day", "Date Range", "Who is expected", "Status", "Actions"]}
          >
            {templates.data?.map((t) => {
              const first = t.schedules[0];
              const scope = first
                ? [
                    first.student_category === "undergraduate"
                      ? "Undergraduate"
                      : first.student_category === "postgraduate"
                        ? "Postgraduate"
                        : null,
                    first.level ? `Level ${first.level}` : null,
                    first.departments.length > 0 ? first.departments.join(" + ") : "Everyone",
                  ]
                    .filter(Boolean)
                    .join(", ")
                : "-";
              return (
                <DataRow
                  key={t.id}
                  cells={[
                    t.name,
                    t.group_kind === "staff" ? "Staff" : "Students",
                    first ? DAY_NAMES[first.day_of_week] : "-",
                    `${t.start_date} to ${t.end_date}`,
                    first?.title_suffix ? `${first.title_suffix} — ${scope}` : scope,
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs ${new Date(t.end_date) < new Date() ? "bg-muted text-muted-foreground" : "bg-green-100 text-green-800"}`}
                    >
                      {new Date(t.end_date) < new Date() ? "Expired" : "Active"}
                    </span>,
                    <div className="flex gap-2">
                      <Button variant="ghost" size="sm" onClick={() => startEditing(t.id)}>
                        Edit
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleGenerate(t.id)}
                        disabled={generateEvents.isPending}
                      >
                        Generate
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-rose-600 hover:text-rose-700"
                        onClick={() => deleteTemplate.mutate(t.id)}
                        disabled={deleteTemplate.isPending}
                      >
                        Delete
                      </Button>
                    </div>,
                  ]}
                />
              );
            })}
          </DataTable>
        )}
      </Panel>
    </div>
  );
}
