import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  History,
  Search,
  Undo2,
  UserCheck,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import type {
  GroupKind,
  ReviewContext,
  ReviewLookAlike,
  ReviewPendingScan,
  ReviewPerson,
  ReviewSavedAnswer,
} from "@/lib/types";

/**
 * Before any report, an administrator confirms what the app could not decide
 * on its own:
 *
 *   1. scans it could not match with certainty -- pick the person (or say the
 *      entry is nobody on the list); the answer is remembered for later uploads;
 *   2. a present person who may be the same as an absent person -- "same
 *      person" merges the two records, "different people" is remembered.
 *
 * Until both lists are empty the report downloads stay disabled (the server
 * refuses them too), so nobody can be reported both present and absent.
 */

function personLine(person: ReviewPerson): string {
  return [
    person.code,
    person.machine && person.machine !== person.code ? `machine ${person.machine}` : null,
    person.department,
  ]
    .filter(Boolean)
    .join(" · ");
}

function kindOfContext(context: ReviewContext): GroupKind {
  return context.type === "mass" ? context.participantType : context.kind;
}

function words(value: string | null | undefined): string[] {
  return (value ?? "")
    .toUpperCase()
    .replace(/[^A-Z\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function digits(value: string | null | undefined): string {
  return (value ?? "").replace(/\D/g, "").replace(/^0+(?=\d)/, "");
}

/** Why a person is suggested for a scan, in plain words. */
function whySuggested(scan: ReviewPendingScan, person: ReviewPerson): string {
  const printed = words(scan.scannedName);
  const theirs = new Set(words(person.name));
  const shared = printed.filter((word) => theirs.has(word)).length;
  const number = digits(scan.scanNumber);
  const hasNumber =
    number !== "" && (digits(person.machine) === number || digits(person.code) === number);
  const name =
    printed.length > 0 && shared === printed.length
      ? "the printed name matches"
      : shared > 0
        ? `${shared} of ${printed.length} printed name word(s) match`
        : "the printed name does not match";
  return hasNumber ? `Has the printed number; ${name}` : `Different number; ${name}`;
}

/** Earlier "not on the list" answers whose printed name matches someone exactly. */
function doubtfulAnswers(answers: ReviewSavedAnswer[] | undefined): ReviewSavedAnswer[] {
  return (answers ?? []).filter((answer) => answer.person === null && answer.nameMatches !== null);
}

function contextKey(context: ReviewContext): unknown[] {
  return context.type === "mass"
    ? ["review", "mass", context.weekId, context.participantType]
    : ["review", "event", context.kind, context.eventId];
}

/** The amber bar on a results page, and the window it opens. */
export function MatchReviewBanner({
  context,
  pendingScans,
  lookAlikes,
}: {
  context: ReviewContext;
  pendingScans: number;
  lookAlikes: number;
}) {
  const { canEdit } = useRoles();
  const [open, setOpen] = useState(false);
  const opened = useRef(false);
  const answers = useQuery({
    queryKey: ["review-answers", kindOfContext(context)],
    queryFn: () => api.review.answers(kindOfContext(context)),
  });
  const waiting = pendingScans + lookAlikes;

  // Open the window by itself the first time there is something to confirm,
  // for someone who is allowed to answer.
  useEffect(() => {
    if (waiting > 0 && canEdit && !opened.current) {
      opened.current = true;
      setOpen(true);
    }
  }, [waiting, canEdit]);

  if (waiting === 0) {
    if ((answers.data?.length ?? 0) === 0) return null;
    return (
      <>
        <div className="flex justify-end">
          <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
            <History className="mr-1 h-4 w-4" /> Saved match answers ({answers.data?.length ?? 0})
          </Button>
        </div>
        <MatchReviewDialog context={context} open={open} onOpenChange={setOpen} />
      </>
    );
  }
  const parts = [
    pendingScans > 0 ? `${pendingScans} scan(s) need you to confirm who they are` : null,
    lookAlikes > 0 ? `${lookAlikes} scanned/absent pair(s) may be the same person` : null,
  ].filter(Boolean);

  return (
    <>
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-900"
      >
        <div className="flex items-start gap-2">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p className="font-medium">Confirm before reporting</p>
            <p className="text-sm">
              {parts.join(" and ")}. Reports can be downloaded once these are answered.
              {canEdit ? "" : " Ask an administrator or operator to answer them."}
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)}>Review now</Button>
      </div>
      <MatchReviewDialog context={context} open={open} onOpenChange={setOpen} />
    </>
  );
}

export function MatchReviewDialog({
  context,
  open,
  onOpenChange,
}: {
  context: ReviewContext;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { canEdit } = useRoles();
  const items = useQuery({
    queryKey: contextKey(context),
    queryFn: () => api.review.items(context),
    enabled: open,
  });
  const answers = useQuery({
    queryKey: ["review-answers", kindOfContext(context)],
    queryFn: () => api.review.answers(kindOfContext(context)),
    enabled: open,
  });
  const data = items.data;
  const remaining = (data?.scans.length ?? 0) + (data?.lookAlikes.length ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Confirm the matches</DialogTitle>
          <DialogDescription>
            These could not be decided with certainty. Each answer is remembered, so the same
            machine entry or the same pair is not asked about again.
          </DialogDescription>
        </DialogHeader>

        {items.isError ? (
          <p role="alert" className="text-sm text-rose-600">
            {(items.error as Error).message}
          </p>
        ) : !data ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : remaining === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">
            <CheckCircle2 className="h-5 w-5" />
            <p>Everything is confirmed. The reports are ready.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {data.scans.length > 0 ? (
              <section className="space-y-3">
                <h3 className="flex items-center gap-2 font-medium">
                  <UserCheck className="h-4 w-4" /> Who is this? ({data.scans.length})
                </h3>
                {data.scans.map((scan) => (
                  <PendingScanCard
                    key={`${scan.scanNumber}|${scan.scannedName}`}
                    kind={data.kind}
                    scan={scan}
                    canEdit={canEdit}
                  />
                ))}
              </section>
            ) : null}

            {data.lookAlikes.length > 0 ? (
              <section className="space-y-3">
                <h3 className="flex items-center gap-2 font-medium">
                  <Users className="h-4 w-4" /> Same person? ({data.lookAlikes.length})
                </h3>
                <p className="text-sm text-muted-foreground">
                  One of them scanned and the other is shown absent. If they are one person, merge
                  them so they are counted once, as present.
                </p>
                {data.lookAlikes.map((pair) => (
                  <LookAlikeCard
                    key={`${pair.present.id}|${pair.absent.id}`}
                    pair={pair}
                    canEdit={canEdit}
                  />
                ))}
              </section>
            ) : null}
          </div>
        )}
        {answers.data && answers.data.length > 0 ? (
          <SavedAnswers kind={kindOfContext(context)} answers={answers.data} canEdit={canEdit} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** Answers given before, with a way to take one back. */
function SavedAnswers({
  kind,
  answers,
  canEdit,
}: {
  kind: GroupKind;
  answers: ReviewSavedAnswer[];
  canEdit: boolean;
}) {
  const refresh = useRefreshEverything();
  const doubtful = doubtfulAnswers(answers);
  const [show, setShow] = useState(doubtful.length > 0);
  const forget = useMutation({
    mutationFn: (answer: ReviewSavedAnswer) =>
      api.review.forget({ kind, scanNumber: answer.scanNumber, nameKey: answer.nameKey }),
    onSuccess: (result) => {
      toast.success(`Answer taken back. ${result.updated} scan(s) matched again.`);
      void refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const ordered = [...doubtful, ...answers.filter((answer) => !doubtful.includes(answer))];

  return (
    <section className="space-y-3 border-t pt-4">
      <button
        type="button"
        className="flex items-center gap-2 font-medium"
        onClick={() => setShow((value) => !value)}
      >
        <History className="h-4 w-4" /> Answers given before ({answers.length})
        {doubtful.length > 0 ? (
          <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
            {doubtful.length} not used
          </span>
        ) : null}
        <span className="text-sm font-normal text-muted-foreground">{show ? "hide" : "show"}</span>
      </button>
      {show ? (
        <ul className="space-y-2">
          {ordered.map((answer) => {
            const wrong = doubtful.includes(answer);
            return (
              <li
                key={`${answer.scanNumber}|${answer.nameKey}`}
                className={`flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 ${
                  wrong ? "border-amber-300 bg-amber-50" : ""
                }`}
              >
                <div className="text-sm">
                  <p className="font-medium">
                    ID {answer.scanNumber || "—"} · {answer.nameKey || "(no name)"}
                  </p>
                  <p className="text-muted-foreground">
                    {answer.person
                      ? `→ ${answer.person.name}${answer.person.code ? ` (${answer.person.code})` : ""}`
                      : "→ Not anyone on the list"}
                  </p>
                  {wrong && answer.nameMatches ? (
                    <p className="text-amber-900">
                      Not used: the printed name is exactly {answer.nameMatches.name}
                      {answer.nameMatches.code ? ` (${answer.nameMatches.code})` : ""}, so the scan
                      counts for them. Undo to remove this answer.
                    </p>
                  ) : null}
                </div>
                {canEdit ? (
                  <Button
                    variant={wrong ? "default" : "outline"}
                    size="sm"
                    disabled={forget.isPending}
                    onClick={() => forget.mutate(answer)}
                  >
                    <Undo2 className="mr-1 h-4 w-4" /> Undo
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}

function useRefreshEverything() {
  const queryClient = useQueryClient();
  // An answer changes results, reports, the master list and the review itself.
  return () => queryClient.invalidateQueries();
}

function PendingScanCard({
  kind,
  scan,
  canEdit,
}: {
  kind: GroupKind;
  scan: ReviewPendingScan;
  canEdit: boolean;
}) {
  const refresh = useRefreshEverything();
  const [choice, setChoice] = useState<string | "none" | null>(scan.candidates[0]?.id ?? null);
  const [searching, setSearching] = useState(false);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<ReviewPerson | null>(null);

  const found = useQuery({
    queryKey: ["review-search", kind, text],
    queryFn: () => api.review.search(kind, text),
    enabled: searching && text.trim().length >= 2,
  });

  const save = useMutation({
    mutationFn: () =>
      api.review.resolveScan({
        kind,
        scanNumber: scan.scanNumber,
        scannedName: scan.scannedName,
        personId: choice === "none" ? null : choice,
      }),
    onSuccess: (result) => {
      toast.success(
        choice === "none"
          ? "Marked as not on the list."
          : `Confirmed. ${result.updated} scan(s) updated.`,
      );
      void refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  const options: ReviewPerson[] = [
    ...scan.candidates,
    ...(picked && !scan.candidates.some((person) => person.id === picked.id) ? [picked] : []),
  ];

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div>
        <p className="text-sm text-muted-foreground">The machine printed</p>
        <p className="font-medium">
          ID {scan.scanNumber ?? "—"} · {scan.scannedName ?? "(no name)"}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {scan.count} scan(s)
          </span>
        </p>
      </div>

      <fieldset className="space-y-2" disabled={!canEdit || save.isPending}>
        <legend className="sr-only">Who is this?</legend>
        {options.map((person) => (
          <label
            key={person.id}
            className="flex cursor-pointer items-start gap-3 rounded-md border p-2 hover:bg-muted/50"
          >
            <input
              type="radio"
              name={`scan-${scan.scanNumber}-${scan.scannedName}`}
              className="mt-1"
              checked={choice === person.id}
              onChange={() => setChoice(person.id)}
            />
            <span>
              <span className="block font-medium">{person.name}</span>
              <span className="block text-sm text-muted-foreground">{personLine(person)}</span>
              <span className="block text-xs text-muted-foreground">
                {whySuggested(scan, person)}
              </span>
            </span>
          </label>
        ))}
        <label className="flex cursor-pointer items-center gap-3 rounded-md border p-2 hover:bg-muted/50">
          <input
            type="radio"
            name={`scan-${scan.scanNumber}-${scan.scannedName}`}
            checked={choice === "none"}
            onChange={() => setChoice("none")}
          />
          <span className="text-sm">Not anyone on the list (leave it unmatched)</span>
        </label>
      </fieldset>

      {canEdit ? (
        <div className="space-y-2">
          {searching ? (
            <>
              <div className="flex items-center gap-2">
                <Search className="h-4 w-4 text-muted-foreground" />
                <Input
                  autoFocus
                  placeholder="Search by name, staff/matric number or machine number"
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              </div>
              {found.data && found.data.length > 0 ? (
                <ul className="max-h-48 space-y-1 overflow-y-auto">
                  {found.data.map((person) => (
                    <li key={person.id}>
                      <button
                        type="button"
                        className="w-full rounded-md border p-2 text-left hover:bg-muted/50"
                        onClick={() => {
                          setPicked(person);
                          setChoice(person.id);
                          setSearching(false);
                        }}
                      >
                        <span className="block font-medium">{person.name}</span>
                        <span className="block text-sm text-muted-foreground">
                          {personLine(person)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              ) : text.trim().length >= 2 && found.isFetched ? (
                <p className="text-sm text-muted-foreground">Nobody found.</p>
              ) : null}
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => setSearching(true)}>
              Someone else…
            </Button>
          )}
          <div className="flex justify-end">
            <Button disabled={choice === null || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Confirm"}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function LookAlikeCard({ pair, canEdit }: { pair: ReviewLookAlike; canEdit: boolean }) {
  const refresh = useRefreshEverything();
  const answer = useMutation({
    mutationFn: (same: boolean) =>
      api.review.resolvePair({
        kind: pair.kind,
        presentId: pair.present.id,
        absentId: pair.absent.id,
        same,
      }),
    onSuccess: (_result, same) => {
      toast.success(same ? "Merged into one person." : "Remembered as different people.");
      void refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <p className="text-sm text-muted-foreground">
        {pair.reason}. Merge only if these two records are the same staff member; if the absent one
        is someone else, choose “Different people” (asked once).
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-emerald-200 bg-emerald-50/60 p-3">
          <p className="text-xs font-medium uppercase text-emerald-800">
            {pair.shownAs === "present" ? "Shown present" : "Scanned, shown out of scope"}
          </p>
          <p className="font-medium">{pair.present.name}</p>
          <p className="text-sm text-muted-foreground">{personLine(pair.present)}</p>
          {pair.printed && pair.printed.length > 0 ? (
            <p className="mt-1 text-sm">
              The machine printed: <span className="font-medium">{pair.printed.join(" · ")}</span>
            </p>
          ) : null}
        </div>
        <div className="rounded-md border border-rose-200 bg-rose-50/60 p-3">
          <p className="text-xs font-medium uppercase text-rose-800">Shown absent</p>
          <p className="font-medium">{pair.absent.name}</p>
          <p className="text-sm text-muted-foreground">{personLine(pair.absent)}</p>
        </div>
      </div>
      {canEdit ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="outline"
            disabled={answer.isPending}
            onClick={() => answer.mutate(false)}
          >
            Different people
          </Button>
          <Button disabled={answer.isPending} onClick={() => answer.mutate(true)}>
            Same person — merge
          </Button>
        </div>
      ) : null}
    </div>
  );
}
