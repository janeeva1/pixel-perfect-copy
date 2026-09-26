import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DepartmentMultiSelect } from "@/components/DepartmentMultiSelect";
import { api, type CreateEventInput } from "@/lib/api";
import { useMutationWithToast } from "@/lib/mutations";
import type { EventCategory, StaffEvent, StudentCategory, StudentEvent } from "@/lib/types";

/**
 * Create an event, or change one that already exists by passing `event`.
 *
 * The scope decides who is expected: leave the filters empty for a general or
 * mass attendance, or narrow to a category, level and any number of
 * departments. Expected attendance is recalculated from the master list on every
 * report, so nothing is frozen here, and narrowing or widening an event re-reads
 * the master list rather than keeping a count that was frozen at some earlier
 * moment.
 *
 * Editing sends every field, so the picker lists have to be the real ones: a
 * level or department missing from the options would read as "not set" and be
 * dropped by the save.
 */
export function EventForm({
  group,
  levels,
  departments,
  event,
  onSaved,
}: {
  group: "student" | "staff";
  levels?: string[];
  departments?: string[];
  event?: StudentEvent | StaffEvent;
  onSaved?: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const student = group === "student";
  const editing = Boolean(event);
  // Only a student event carries a category and a level, so this is how the
  // union is narrowed without a cast.
  const studentEvent = event && "category" in event ? event : null;
  const [form, setForm] = useState<{
    title: string;
    eventDate: string;
    eventCategory: EventCategory;
    startTime: string;
    endTime: string;
    category: StudentCategory | "all";
    level: string;
    notes: string;
  }>(() => ({
    title: event?.title ?? "",
    eventDate: event?.event_date ?? new Date().toISOString().slice(0, 10),
    eventCategory: event?.event_category ?? "other",
    startTime: event?.start_time ?? "",
    endTime: event?.end_time ?? "",
    category: studentEvent?.category ?? "all",
    level: studentEvent?.level ?? "all",
    notes: event?.notes ?? "",
  }));
  const [departmentCodes, setDepartmentCodes] = useState<string[]>(
    student && event ? event.departments : [],
  );
  const [staffDepartments, setStaffDepartments] = useState<string[]>(
    !student && event ? event.departments : [],
  );

  // The student codes come from the matric numbers and are passed in; the staff
  // department names are worked out from the staff file, so they are fetched.
  const staffOptions = useQuery({
    queryKey: ["staff-departments"],
    queryFn: () => api.staffDepartments(),
    enabled: !student,
  });

  const save = useMutationWithToast(
    (input: CreateEventInput) => {
      if (event) return api.updateEvent(group, event.id, input);
      return student ? api.createStudentEvent(input) : api.createStaffEvent(input);
    },
    {
      successMessage: (saved) => (event ? `Saved “${saved.title}”.` : `Created “${saved.title}”.`),
      errorMessage: "The event could not be saved.",
      mutationOptions: {
        onSuccess: (saved) => {
          if (!event) {
            void navigate({ to: `/${group}-events/$eventId`, params: { eventId: saved.id } });
            return;
          }
          void queryClient.invalidateQueries({ queryKey: [group, "event", event.id] });
          void queryClient.invalidateQueries({ queryKey: [`${group}-events`] });
          onSaved?.();
        },
      },
    },
  );

  const set = (next: Partial<typeof form>) => setForm((current) => ({ ...current, ...next }));

  return (
    <form
      className="grid gap-4 md:grid-cols-2"
      onSubmit={(submitEvent) => {
        submitEvent.preventDefault();
        void save.mutate({
          title: form.title,
          eventDate: form.eventDate,
          eventCategory: form.eventCategory,
          startTime: form.startTime || null,
          endTime: form.endTime || null,
          category: student && form.category !== "all" ? form.category : null,
          level: student && form.level !== "all" ? form.level : null,
          departmentCodes: student ? departmentCodes : null,
          departments: student ? null : staffDepartments,
          notes: form.notes || null,
        });
      }}
    >
      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium" htmlFor={`${group}-title`}>
          Event title
        </label>
        <Input
          id={`${group}-title`}
          required
          maxLength={160}
          placeholder={
            student ? "CSC 200 level lecture, 2 September" : "Staff meeting, 2 September"
          }
          value={form.title}
          onChange={(event) => set({ title: event.target.value })}
        />
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor={`${group}-event-category`}>
          Event type
        </label>
        <Select
          value={form.eventCategory}
          onValueChange={(value) => set({ eventCategory: value as EventCategory })}
        >
          <SelectTrigger id={`${group}-event-category`} className="h-9">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="other">Other Events</SelectItem>
            <SelectItem value="community_mass">Community Mass</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          Reports and the dashboard can be narrowed to Community Mass on their own.
        </p>
      </div>

      <div className="space-y-1">
        <label className="text-sm font-medium" htmlFor={`${group}-date`}>
          Date
        </label>
        <Input
          id={`${group}-date`}
          type="date"
          required
          value={form.eventDate}
          onChange={(event) => set({ eventDate: event.target.value })}
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor={`${group}-start`}>
            Opens (optional)
          </label>
          <Input
            id={`${group}-start`}
            type="time"
            value={form.startTime}
            onChange={(event) => set({ startTime: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <label className="text-sm font-medium" htmlFor={`${group}-end`}>
            Closes (optional)
          </label>
          <Input
            id={`${group}-end`}
            type="time"
            value={form.endTime}
            onChange={(event) => set({ endTime: event.target.value })}
          />
        </div>
      </div>

      {student ? (
        <>
          <div className="space-y-1">
            <label className="text-sm font-medium">Category</label>
            <Select
              value={form.category}
              onValueChange={(value) => set({ category: value as StudentCategory | "all" })}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All students</SelectItem>
                <SelectItem value="undergraduate">Undergraduate only</SelectItem>
                <SelectItem value="postgraduate">Postgraduate only</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Level</label>
            <Select value={form.level} onValueChange={(value) => set({ level: value })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All levels</SelectItem>
                {(levels ?? []).map((level) => (
                  <SelectItem key={level} value={level}>
                    Level {level}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      ) : null}

      {student ? (
        <DepartmentMultiSelect
          id={`${group}-departments`}
          label="Departments"
          emptyLabel="All departments"
          value={departmentCodes}
          onChange={setDepartmentCodes}
          options={(departments ?? []).map((code) => ({ value: code, label: code }))}
          hint="Leave empty to expect every student. Picking several makes one event covering all of them."
        />
      ) : (
        <DepartmentMultiSelect
          id={`${group}-departments`}
          label="Departments"
          emptyLabel="All staff"
          value={staffDepartments}
          onChange={setStaffDepartments}
          options={(staffOptions.data?.departments ?? []).map((option) => ({
            value: option.department,
            label: option.department,
            count: option.total,
          }))}
          hint={
            staffOptions.data && staffOptions.data.unassigned > 0
              ? `${staffOptions.data.unassigned} staff have no department in their file row and are expected only when this is left empty.`
              : "Leave empty to expect every member of staff."
          }
        />
      )}

      <div className="space-y-1 md:col-span-2">
        <label className="text-sm font-medium" htmlFor={`${group}-notes`}>
          Notes (optional)
        </label>
        <Textarea
          id={`${group}-notes`}
          rows={2}
          maxLength={2000}
          value={form.notes}
          onChange={(event) => set({ notes: event.target.value })}
        />
      </div>

      <div className="flex items-center gap-3 md:col-span-2">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending
            ? editing
              ? "Saving…"
              : "Creating…"
            : editing
              ? "Save changes"
              : `Create ${student ? "student" : "staff"} event`}
        </Button>
        {save.isError ? (
          <p className="text-sm text-rose-600">{(save.error as Error).message}</p>
        ) : null}
      </div>
    </form>
  );
}
