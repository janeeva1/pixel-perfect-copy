import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { useMutationWithToast } from "@/lib/mutations";
import type { StaffEvent, StudentEvent } from "@/lib/types";

/**
 * Close an event ("stop counting"), or reopen it.
 *
 * Closing writes down who the event expects at that moment and keeps every
 * match as it is, so people added to the staff or student list afterwards are
 * never counted there, and nothing re-matches its scans. Files can only be
 * added to an open event. Reopening makes the event follow the list again.
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
      : `“${event.title}” is closed: its numbers no longer change.`,
    errorMessage: "The status could not be changed.",
    mutationOptions: {
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: [`${group}-events`] });
        void queryClient.invalidateQueries({ queryKey: [group, "event", event.id] });
      },
    },
  });

  const ask = () => {
    const question = finalized
      ? `Reopen “${event.title}”?\n\nIt will follow the ${group} list again: anyone added to the list since it was closed will be counted (absent unless they scanned).`
      : `Close “${event.title}”?\n\nWho was expected and who was present are kept as they are now. People added to the ${group} list later will not be counted, and no more files can be added until you reopen it.`;
    if (window.confirm(question)) change.mutate();
  };

  return (
    <Button
      variant={finalized ? "outline" : "default"}
      size={size}
      disabled={change.isPending}
      onClick={ask}
    >
      {change.isPending ? "…" : finalized ? "Reopen" : "Close — stop counting"}
    </Button>
  );
}
