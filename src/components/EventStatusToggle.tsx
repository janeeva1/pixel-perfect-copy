import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useMutationWithToast } from "@/lib/mutations";
import type { StaffEvent, StudentEvent } from "@/lib/types";

/**
 * Mark an event final, or take it back to draft.
 *
 * "Reopen" is the same thing as suspending an event: a draft is one whose
 * attendance has not been signed off, so it stops being treated as settled and
 * `finalized_at` is cleared. There is no separate suspended state, because the
 * two the schema allows are the two anybody actually needs, and a third would
 * only mean deciding again later what a report should do with it.
 *
 * The button says which way it will go, because an event that is already final
 * offering "Mark final" is a trap.
 */
export function EventStatusToggle({
  group,
  event,
  size = "sm",
}: {
  group: "student" | "staff";
  event: Pick<StudentEvent | StaffEvent, "id" | "title" | "status">;
  size?: "sm" | "default";
}) {
  const queryClient = useQueryClient();
  const finalized = event.status === "finalized";
  const next = finalized ? "draft" : "finalized";

  const change = useMutationWithToast(() => api.setEventStatus(group, event.id, next), {
    successMessage: finalized
      ? `“${event.title}” is open again.`
      : `“${event.title}” marked final.`,
    errorMessage: "The status could not be changed.",
    mutationOptions: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [`${group}-events`] });
        void queryClient.invalidateQueries({ queryKey: [group, "event", event.id] });
      },
    },
  });

  return (
    <Button
      variant={finalized ? "outline" : "default"}
      size={size}
      disabled={change.isPending}
      onClick={() => change.mutate()}
    >
      {change.isPending ? "…" : finalized ? "Reopen" : "Mark final"}
    </Button>
  );
}
