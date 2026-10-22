import { useEffect, useState } from "react";
import { Download, RefreshCw, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { desktopBridge, type UpdateStatus } from "@/lib/electron";
import { toast } from "sonner";

/**
 * The Update section: the app looking after itself.
 *
 * An install that has been used for months still has to be able to move to a
 * newer build, and the person using it should not have to know how. So this
 * section does the whole job in three clicks: check the update folder, fetch
 * what is there, and restart into it.
 *
 * The address of the update folder is a setting rather than a constant,
 * because the app may be installed on a machine that has never heard of the
 * server that hosts the builds. It is written to the install's own settings
 * file and remembered.
 */
export function AppUpdate({
  showFeedUrl = true,
  compact = false,
}: {
  /** Whether the address of the update folder can be edited here. */
  showFeedUrl?: boolean;
  /** The smaller form, for the window's side panel. */
  compact?: boolean;
}) {
  const bridge = desktopBridge();
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [feedUrl, setFeedUrl] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;

    void bridge.update.status().then((current) => {
      if (cancelled) return;
      setStatus(current);
      setFeedUrl(current.feedUrl);
    });

    const stop = bridge.update.onEvent((event) => {
      if (!cancelled) setStatus(event.status);
    });

    return () => {
      cancelled = true;
      stop();
    };
  }, [bridge]);

  if (!bridge) {
    return (
      <p className="text-sm text-muted-foreground">
        Updates are for the desktop app. This page is running in a browser, so there is no program
        here to update.
      </p>
    );
  }

  async function run(action: () => Promise<UpdateStatus>): Promise<void> {
    setBusy(true);
    try {
      const next = await action();
      setStatus(next);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveFeedUrl(): Promise<void> {
    if (!bridge) return;
    await run(async () => {
      const next = await bridge.update.setFeedUrl(feedUrl.trim());
      toast.success(
        feedUrl.trim()
          ? "The update address has been saved."
          : "The update address has been cleared.",
      );
      return next;
    });
  }

  const currentVersion = status?.currentVersion ?? "";
  const canUpdate = status?.supported === true;
  const isNewer = status?.state === "available" || status?.state === "downloaded";
  const downloading = status?.state === "downloading";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-sm text-muted-foreground">
          Installed version{" "}
          <span className="font-medium text-foreground">{currentVersion || "—"}</span>
        </span>
        {status?.availableVersion && isNewer ? (
          <span className="text-sm text-amber-700 dark:text-amber-400">
            Version {status.availableVersion} is available
          </span>
        ) : null}
      </div>

      {showFeedUrl ? (
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-64 flex-1">
            <label htmlFor="update-feed" className="mb-1 block text-sm font-medium">
              Update folder address
            </label>
            <Input
              id="update-feed"
              value={feedUrl}
              placeholder="https://the-server/attendance-register/"
              onChange={(event) => setFeedUrl(event.target.value)}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              The web folder that holds <code>latest.yml</code> and the installer. Leave it empty to
              use the address the build was made with.
            </p>
          </div>
          <Button variant="outline" onClick={() => void saveFeedUrl()} disabled={busy}>
            Save address
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => void run(() => bridge.update.check())}
          disabled={busy || !canUpdate}
        >
          <RefreshCw className={busy ? "mr-2 size-4 animate-spin" : "mr-2 size-4"} />
          Check for updates
        </Button>

        {status?.state === "available" ? (
          <Button onClick={() => void run(() => bridge.update.download())} disabled={busy}>
            <Download className="mr-2 size-4" />
            Download version {status.availableVersion}
          </Button>
        ) : null}

        {status?.state === "downloaded" ? (
          <Button onClick={() => void run(() => bridge.update.install())} disabled={busy}>
            <RotateCw className="mr-2 size-4" />
            Restart and install
          </Button>
        ) : null}
      </div>

      {downloading ? (
        <div className="space-y-1">
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${status?.percent ?? 0}%` }}
            />
          </div>
          <p className="text-sm text-muted-foreground">
            Downloading… {status?.percent ?? 0}%
            {status && status.total > 0
              ? ` (${Math.round(status.transferred / 1_048_576)} of ${Math.round(status.total / 1_048_576)} MB)`
              : ""}
          </p>
        </div>
      ) : null}

      {status?.state === "not-available" ? (
        <p className="text-sm text-muted-foreground">
          This is the newest version. Nothing to install.
        </p>
      ) : null}

      {status?.state === "error" && status.error ? (
        <p className="text-sm text-destructive">{status.error}</p>
      ) : null}

      {!canUpdate && status?.reason ? (
        <p className="text-sm text-muted-foreground">{status.reason}</p>
      ) : null}

      {compact && status?.releaseNotes ? (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{status.releaseNotes}</p>
      ) : null}
    </div>
  );
}
