import { ColumnGuide, Hint } from "@/components/Hint";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  CheckCircle2,
  Computer,
  Loader2,
  RefreshCw,
  Search,
  Server,
  Unplug,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/attendance-ui";
import { api } from "@/lib/api";
import { useRoles } from "@/lib/useAuth";
import type { FoundMain } from "@/lib/types";

export const Route = createFileRoute("/_authenticated/sync")({
  component: SyncPage,
});

function ago(value: string | null): string {
  if (!value) return "never";
  const time = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`).getTime();
  if (Number.isNaN(time)) return value;
  const minutes = Math.round((Date.now() - time) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minute(s) ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour(s) ago`;
  return new Date(time).toLocaleString("en-GB");
}

/**
 * Sync between computers in the same office, with nothing to install but this
 * app: one computer is Main, the others connect to it with a 6-digit code and
 * then keep in step by themselves every few minutes.
 */
function SyncPage() {
  const queryClient = useQueryClient();
  const { isAdmin, canEdit } = useRoles();
  const status = useQuery({
    queryKey: ["peer-status"],
    queryFn: api.peer.status,
    refetchInterval: 10_000,
  });
  const refresh = () => void queryClient.invalidateQueries();

  const becomeMain = useMutation({
    mutationFn: api.peer.becomeMain,
    onSuccess: () => {
      toast.success("This is now the Main computer.");
      refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const leave = useMutation({
    mutationFn: api.peer.leave,
    onSuccess: () => {
      toast.success("Sync is off on this computer. Its data stays here.");
      refresh();
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const syncNow = useMutation({
    mutationFn: api.peer.syncNow,
    onSuccess: (result) => {
      toast.success(result.message);
      refresh();
    },
    onError: (error) => {
      toast.error((error as Error).message);
      refresh();
    },
  });

  const data = status.data;
  if (status.isError) {
    return (
      <p role="alert" className="text-sm text-rose-600">
        {(status.error as Error).message}
      </p>
    );
  }
  if (!data) return <p className="text-sm text-muted-foreground">Loading…</p>;

  return (
    <div className="space-y-6">
      <Panel
        title="Sync computers"
        description={`Keep several computers in the office in step: staff and student lists, events, Weekly Mass, answers to "confirm the matches", always-present staff and debts. Nothing else needs to be installed. This computer: ${data.deviceName}.`}
      >
        {data.role === "off" ? (
          isAdmin ? (
            <SetUp
              onMain={() => becomeMain.mutate()}
              busy={becomeMain.isPending}
              onJoined={refresh}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              Sync is not set up on this computer. Ask an administrator to set it up.
            </p>
          )
        ) : null}

        {data.role === "main" ? (
          <div className="space-y-5">
            <div className="flex items-start gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-emerald-900">
              <Server className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="space-y-1">
                <p className="font-medium">This is the Main computer.</p>
                <p className="text-sm">
                  Keep the Attendance Register app open on it while others work. On each other
                  computer, open Sync computers, choose “Connect to the Main computer”, and type
                  this code:
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-6">
              <div>
                <p className="text-sm text-muted-foreground">Pairing code</p>
                <p className="font-mono text-4xl font-semibold tracking-[0.3em]">
                  {data.pairingCode}
                </p>
              </div>
              <div className="text-sm text-muted-foreground">
                <p>
                  Network address{data.addresses.length > 1 ? "es" : ""}:{" "}
                  <span className="font-mono">{data.addresses.join(", ") || "none found"}</span>
                </p>
                <p>
                  {data.listening ? (
                    <span className="text-emerald-700">Ready for other computers.</span>
                  ) : (
                    <span className="text-rose-700">
                      Not reachable yet{data.lastError ? `: ${data.lastError}` : "."}
                    </span>
                  )}
                </p>
              </div>
            </div>
            <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
              If Windows asks whether Attendance Register may use the network, choose{" "}
              <strong>Allow</strong> (private networks), or the other computers will not find this
              one.
            </p>
            <div>
              <h3 className="mb-2 font-medium">Computers connected to this one</h3>
              {data.devices.length === 0 ? (
                <p className="text-sm text-muted-foreground">None yet.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.devices.map((device) => (
                    <li
                      key={`${device.name}-${device.address}`}
                      className="flex items-center gap-2"
                    >
                      <Computer className="h-4 w-4 text-muted-foreground" />
                      <span className="font-medium">{device.name ?? "Computer"}</span>
                      <span className="text-muted-foreground">
                        {device.address} · last synced {ago(device.lastSeenAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            {isAdmin ? (
              <Button
                variant="outline"
                disabled={leave.isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      "Stop being the Main computer? The other computers will not be able to sync until a Main computer is set up again.",
                    )
                  ) {
                    leave.mutate();
                  }
                }}
              >
                <Unplug className="mr-1 h-4 w-4" /> Stop being the Main computer
              </Button>
            ) : null}
            <Hint>
              The code above is what the other computers type to connect. Stop being the Main
              computer ends syncing for everyone until another Main computer is set up.
            </Hint>
          </div>
        ) : null}

        {data.role === "member" ? (
          <div className="space-y-5">
            <div
              className={`flex items-start gap-3 rounded-lg border p-4 ${
                data.lastError
                  ? "border-amber-300 bg-amber-50 text-amber-900"
                  : "border-emerald-300 bg-emerald-50 text-emerald-900"
              }`}
            >
              {data.lastError ? (
                <XCircle className="mt-0.5 h-5 w-5 shrink-0" />
              ) : (
                <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0" />
              )}
              <div className="space-y-1 text-sm">
                <p className="text-base font-medium">
                  Connected to the Main computer “{data.main?.name ?? data.main?.address}”
                </p>
                <p>
                  Last synchronized {ago(data.lastSyncAt)}
                  {data.lastResult ? ` — ${data.lastResult.replace(/\.$/, "")}` : ""}. It
                  synchronizes by itself every few minutes.
                </p>
                {data.pending > 0 ? (
                  <p>{data.pending} change(s) made here are waiting to be sent.</p>
                ) : null}
                {data.lastError ? (
                  <p className="font-medium">
                    Last attempt: {data.lastError} This computer keeps working; it will send its
                    changes when the Main computer can be reached.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {canEdit ? (
                <Button
                  disabled={syncNow.isPending || data.syncing}
                  onClick={() => syncNow.mutate()}
                >
                  {syncNow.isPending || data.syncing ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <RefreshCw className="mr-1 h-4 w-4" />
                  )}
                  {syncNow.isPending || data.syncing ? "Synchronizing…" : "Synchronize now"}
                </Button>
              ) : null}
              {isAdmin ? (
                <Button
                  variant="outline"
                  disabled={leave.isPending}
                  onClick={() => {
                    if (
                      window.confirm(
                        "Disconnect from the Main computer? This computer keeps all its data but stops syncing.",
                      )
                    ) {
                      leave.mutate();
                    }
                  }}
                >
                  <Unplug className="mr-1 h-4 w-4" /> Disconnect
                </Button>
              ) : null}
            </div>
            <Hint>
              Synchronize now sends this computer's changes to the Main computer and brings back
              everyone else's (this also happens on its own every 3 minutes). Disconnect stops
              syncing; this computer keeps its data.
            </Hint>
          </div>
        ) : null}
      </Panel>

      {isAdmin ? <ComputerName current={data.deviceName} /> : null}
    </div>
  );
}

/** First-time choice: be Main, or connect to Main. */
function SetUp({
  onMain,
  busy,
  onJoined,
}: {
  onMain: () => void;
  busy: boolean;
  onJoined: () => void;
}) {
  const [found, setFound] = useState<FoundMain[] | null>(null);
  const [picked, setPicked] = useState<string>("");
  const [code, setCode] = useState("");
  const [typed, setTyped] = useState("");
  const look = useMutation({
    mutationFn: api.peer.discover,
    onSuccess: (list) => {
      setFound(list);
      if (list.length === 1) setPicked(list[0]!.address);
    },
    onError: (error) => toast.error((error as Error).message),
  });
  const join = useMutation({
    mutationFn: () => api.peer.join(picked || typed.trim(), code),
    onSuccess: () => {
      toast.success("Connected. The first sync has started; it can take a minute.");
      onJoined();
    },
    onError: (error) => toast.error((error as Error).message),
  });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="space-y-3 rounded-lg border p-4">
        <h3 className="flex items-center gap-2 font-medium">
          <Server className="h-4 w-4" /> This is the Main computer
        </h3>
        <p className="text-sm text-muted-foreground">
          Choose one computer that is usually on during work hours (for example the office desktop).
          The others will connect to it. Do this on one computer only.
        </p>
        <Button disabled={busy} onClick={onMain}>
          Make this the Main computer
        </Button>
      </div>

      <div className="space-y-3 rounded-lg border p-4">
        <h3 className="flex items-center gap-2 font-medium">
          <Computer className="h-4 w-4" /> Connect to the Main computer
        </h3>
        <p className="text-sm text-muted-foreground">
          The Main computer must be on, with the app open, on the same network.
        </p>
        <Button variant="outline" disabled={look.isPending} onClick={() => look.mutate()}>
          {look.isPending ? (
            <Loader2 className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-1 h-4 w-4" />
          )}
          {look.isPending ? "Looking…" : "Find the Main computer"}
        </Button>

        {found !== null ? (
          found.length === 0 ? (
            <div className="space-y-2 text-sm">
              <p className="text-amber-800">
                No Main computer answered. Check that it is on with the app open, and that both
                computers are on the same network. Or type its network address (shown on the Main
                computer's Sync page):
              </p>
              <Input
                className="w-56 font-mono"
                placeholder="e.g. 192.168.1.20"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
          ) : (
            <div className="space-y-1">
              {found.map((main) => (
                <label
                  key={main.deviceId}
                  className="flex cursor-pointer items-center gap-2 text-sm"
                >
                  <input
                    type="radio"
                    name="main"
                    checked={picked === main.address}
                    onChange={() => setPicked(main.address)}
                  />
                  <span className="font-medium">{main.name}</span>
                  <span className="text-muted-foreground">{main.address}</span>
                </label>
              ))}
            </div>
          )
        ) : null}

        {found !== null && (picked || typed.trim()) ? (
          <div className="flex flex-wrap items-end gap-2">
            <div className="space-y-1">
              <Label htmlFor="pair-code">6-digit code from the Main computer</Label>
              <Hint>Shown on the Sync computers page of the Main computer.</Hint>
              <Input
                id="pair-code"
                inputMode="numeric"
                className="w-40 font-mono text-lg tracking-widest"
                maxLength={6}
                value={code}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
            </div>
            <Button disabled={code.length !== 6 || join.isPending} onClick={() => join.mutate()}>
              {join.isPending ? "Connecting…" : "Connect"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A friendly name, so Main's list says "Bursary PC" rather than "DESKTOP-BDLGJUC". */
function ComputerName({ current }: { current: string }) {
  const queryClient = useQueryClient();
  const [name, setName] = useState(current);
  const save = useMutation({
    mutationFn: () => api.peer.rename(name),
    onSuccess: () => {
      toast.success("Saved.");
      void queryClient.invalidateQueries({ queryKey: ["peer-status"] });
    },
    onError: (error) => toast.error((error as Error).message),
  });
  return (
    <Panel title="This computer's name" description="Shown to the other computers.">
      <div className="flex flex-wrap items-end gap-2">
        <Input className="w-64" value={name} onChange={(event) => setName(event.target.value)} />
        <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate()}>
          Save name
        </Button>
      </div>
    </Panel>
  );
}
