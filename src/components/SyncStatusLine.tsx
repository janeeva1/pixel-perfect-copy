import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw, Server, TriangleAlert } from "lucide-react";
import { api } from "@/lib/api";

/**
 * One line at the foot of the menu, on a computer that syncs: "Main computer",
 * "Synced 2 min ago", or that the Main computer could not be reached. Nothing on
 * a computer that does not sync.
 */
export function SyncStatusLine() {
  const status = useQuery({
    queryKey: ["peer-status"],
    queryFn: api.peer.status,
    refetchInterval: 60_000,
    retry: false,
  });
  const data = status.data;
  if (!data || data.role === "off") return null;

  let icon = <RefreshCw className="size-3.5" />;
  let text = "";
  if (data.role === "main") {
    icon = <Server className="size-3.5" />;
    text = "Main computer for sync";
  } else if (data.lastError) {
    icon = <TriangleAlert className="size-3.5 text-amber-300" />;
    text = "Main computer not reachable";
  } else if (data.lastSyncAt) {
    const minutes = Math.max(
      0,
      Math.round((Date.now() - new Date(data.lastSyncAt).getTime()) / 60000),
    );
    text = minutes < 1 ? "Synced just now" : `Synced ${minutes} min ago`;
  } else {
    text = "Waiting for first sync";
  }
  return (
    <Link
      to="/sync"
      className="flex items-center gap-2 rounded-md px-3 py-1.5 text-xs opacity-80 hover:bg-sidebar-accent"
    >
      {icon}
      <span className="truncate">{text}</span>
    </Link>
  );
}
