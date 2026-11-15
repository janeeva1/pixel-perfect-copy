// Built-in sync between computers ---------------------------------------------
//
// Only the desktop app is installed. One computer is "Main"; the others are
// "members" that keep their own full copy (so they work when Main is off) and
// exchange changes with Main over the office network:
//
//   * Main listens on the network on PEER_PORT, for sync only (the app itself
//     stays on 127.0.0.1), and answers discovery broadcasts on DISCOVERY_PORT,
//     so a member finds it without anyone typing an address.
//   * A member is joined with Main's 6-digit pairing code. Every few minutes,
//     and when "Synchronize now" is pressed, it sends Main the changes made on
//     it, then takes the changes made everywhere else.
//
// What a change is comes from migration 017: triggers record the key of every
// row inserted, updated or deleted in a shared table. A sync sends each such row
// as it is now, or "deleted" when it is gone, in the order the changes were
// first made (parents before children).
//
// The same person created on two computers (each imported the staff list) has
// two ids. A row whose staff number / matric number / email is already here
// under another id is paired with it (peer_id_map), and every reference to the
// other id -- scans, expected lists, review answers -- is read as this one.

import { randomInt } from "node:crypto";
import dgram from "node:dgram";
import http from "node:http";
import os from "node:os";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { activeDriver, getDb } from "@/server/db";
import { HttpError } from "@/server/http";
import type { FoundMain, PeerStatus, PeerSyncSummary } from "@/lib/types";

export const PEER_PORT = 47820;
export const DISCOVERY_PORT = 47821;
const DISCOVER_MESSAGE = "ATTENDANCE-REGISTER-DISCOVER";
const AUTO_SYNC_MS = 3 * 60 * 1000;
const BATCH = 1000;

type Role = "off" | "main" | "member";
type Kind = "staff" | "student" | "user";
type Row = Record<string, unknown>;

/** One change as it travels: the table, the row's key, and the row (null = deleted). */
export type Change = { tbl: string; pk: Record<string, unknown>; row: Row | null };

type TableSpec = {
  pk: string[];
  /** Rows carry updated_at: the newer one wins. */
  lww: boolean;
  /** A person table: its id is paired across computers by this column. */
  person?: { kind: Kind; natural: string };
  /** Another unique column set: an arriving row that matches it is that row. */
  natural?: string[];
};

/** The shared tables, in the order a first sync applies them. */
const TABLES: Record<string, TableSpec> = {
  users: { pk: ["id"], lww: true, person: { kind: "user", natural: "email" } },
  profiles: { pk: ["id"], lww: true },
  user_roles: { pk: ["id"], lww: true, natural: ["user_id", "role"] },
  students: { pk: ["id"], lww: true, person: { kind: "student", natural: "matric_no" } },
  staff: { pk: ["id"], lww: true, person: { kind: "staff", natural: "staff_no" } },
  staff_presence_overrides: { pk: ["scan_number"], lww: true },
  recurring_templates: { pk: ["id"], lww: true },
  recurring_schedules: { pk: ["id"], lww: false },
  recurring_schedule_departments: { pk: ["schedule_id", "department"], lww: false },
  student_events: { pk: ["id"], lww: true },
  student_event_departments: { pk: ["event_id", "department_code"], lww: false },
  staff_events: { pk: ["id"], lww: true },
  staff_event_departments: { pk: ["event_id", "department"], lww: false },
  student_event_uploads: { pk: ["id"], lww: false },
  staff_event_uploads: { pk: ["id"], lww: false },
  student_scans: { pk: ["id"], lww: false },
  staff_scans: { pk: ["id"], lww: false },
  mass_department_weekdays: { pk: ["id"], lww: true, natural: ["department_code"] },
  mass_weeks: { pk: ["id"], lww: true },
  mass_week_weekdays: { pk: ["mass_week_id", "day_of_week"], lww: false },
  mass_expected: {
    pk: ["id"],
    lww: false,
    natural: ["mass_week_id", "participant_type", "person_id"],
  },
  mass_uploads: { pk: ["id"], lww: false },
  mass_scans: { pk: ["id"], lww: false },
  scan_aliases: { pk: ["kind", "scan_number", "name_key"], lww: false },
  distinct_people: { pk: ["kind", "person_a", "person_b"], lww: false },
  debt_rates: { pk: ["participant_type"], lww: true },
};

const USER_COLUMNS = ["created_by", "uploaded_by", "updated_by", "actor_id", "user_id"];

// Settings ---------------------------------------------------------------------

type Settings = {
  role: Role;
  device_id: string;
  device_name: string | null;
  pairing_code: string | null;
  main_address: string | null;
  main_name: string | null;
  main_device_id: string | null;
  pushed_seq: number;
  pulled_seq: number;
  last_sync_at: string | null;
  last_result: string | null;
  last_error: string | null;
};

function db(): SqliteDatabase {
  if (activeDriver() !== "sqlite") {
    throw new HttpError(400, "Sync between computers works with the desktop app's own database.");
  }
  return getDb();
}

function settings(): Settings {
  return db().prepare("SELECT * FROM peer_settings WHERE id = 1").get() as Settings;
}

function saveSettings(patch: Partial<Settings>): void {
  const keys = Object.keys(patch);
  if (keys.length === 0) return;
  db()
    .prepare(
      `UPDATE peer_settings SET ${keys.map((key) => `${key} = ?`).join(", ")},
              updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
    )
    .run(...keys.map((key) => (patch as Record<string, unknown>)[key] ?? null));
}

function deviceName(): string {
  return settings().device_name || os.hostname();
}

function schemaVersion(): number {
  return Number(db().pragma("user_version", { simple: true }));
}

// Reading changes ----------------------------------------------------------------

/**
 * Changes recorded after `since`, as rows to send, at most BATCH log entries.
 * `exceptOrigin` leaves out what came from that computer (it has it already);
 * `onlyLocal` keeps only changes made on this computer.
 */
export function readChanges(options: {
  since: number;
  exceptOrigin?: string | null;
  onlyLocal?: boolean;
}): { changes: Change[]; last: number; more: boolean } {
  const handle = db();
  const where = options.onlyLocal
    ? "origin IS NULL"
    : options.exceptOrigin
      ? "(origin IS NULL OR origin <> ?)"
      : "1 = 1";
  // The window is fixed first, so a change recorded while this runs is left for
  // the next sync rather than skipped by the cursor.
  const top = (
    handle.prepare("SELECT COALESCE(MAX(seq), 0) AS top FROM change_log").get() as { top: number }
  ).top;
  const params: unknown[] = [options.since, top];
  if (!options.onlyLocal && options.exceptOrigin) params.push(options.exceptOrigin);
  const entries = handle
    .prepare(
      `SELECT seq, tbl, pk FROM change_log WHERE seq > ? AND seq <= ? AND ${where} ORDER BY seq LIMIT ?`,
    )
    .all(...params, BATCH) as Array<{ seq: number; tbl: string; pk: string }>;
  const more = entries.length === BATCH;
  // Entries skipped by the filter still move the cursor.
  const last = more ? entries[entries.length - 1]!.seq : Math.max(options.since, top);

  // Each row once, at the place of its FIRST change (so a week still comes
  // before its scans), with its content as it is NOW.
  const seen = new Set<string>();
  const changes: Change[] = [];
  for (const entry of entries) {
    const spec = TABLES[entry.tbl];
    if (!spec) continue;
    const key = `${entry.tbl}|${entry.pk}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const pk = JSON.parse(entry.pk) as Record<string, unknown>;
    const row = handle
      .prepare(
        `SELECT * FROM ${entry.tbl} WHERE ${spec.pk.map((column) => `${column} IS ?`).join(" AND ")}`,
      )
      .get(...spec.pk.map((column) => pk[column])) as Row | undefined;
    changes.push({ tbl: entry.tbl, pk, row: row ?? null });
  }
  return { changes, last, more };
}

// Applying changes ---------------------------------------------------------------

const columnCache = new Map<string, Set<string>>();
function columnsOf(table: string): Set<string> {
  let columns = columnCache.get(table);
  if (!columns) {
    columns = new Set(
      (db().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
        (column) => column.name,
      ),
    );
    columnCache.set(table, columns);
  }
  return columns;
}

function mapped(kind: Kind, id: unknown): unknown {
  if (typeof id !== "string" || id === "") return id;
  const row = db()
    .prepare("SELECT local_id FROM peer_id_map WHERE kind = ? AND foreign_id = ?")
    .get(kind, id) as { local_id: string } | undefined;
  return row ? row.local_id : id;
}

function personKindOf(value: unknown): Kind {
  return value === "staff" ? "staff" : "student";
}

/** Read every reference to a person or user as this computer's id for them. */
function translate(table: string, row: Row): Row {
  const out: Row = { ...row };
  for (const column of USER_COLUMNS) if (column in out) out[column] = mapped("user", out[column]);
  if (table === "profiles") out["id"] = mapped("user", out["id"]);
  if (table === "staff_scans") out["staff_id"] = mapped("staff", out["staff_id"]);
  if (table === "student_scans") out["student_id"] = mapped("student", out["student_id"]);
  if (table === "mass_scans" || table === "mass_expected") {
    out["person_id"] = mapped(personKindOf(out["participant_type"]), out["person_id"]);
  }
  if (table === "scan_aliases")
    out["person_id"] = mapped(personKindOf(out["kind"]), out["person_id"]);
  if (table === "distinct_people") {
    out["person_a"] = mapped(personKindOf(out["kind"]), out["person_a"]);
    out["person_b"] = mapped(personKindOf(out["kind"]), out["person_b"]);
  }
  if ("review_candidates" in out && typeof out["review_candidates"] === "string") {
    const kind: Kind =
      table === "staff_scans"
        ? "staff"
        : table === "student_scans"
          ? "student"
          : personKindOf(out["participant_type"]);
    try {
      const ids = JSON.parse(out["review_candidates"]) as unknown[];
      out["review_candidates"] = JSON.stringify(ids.map((id) => mapped(kind, id)));
    } catch {
      // not a list: leave it
    }
  }
  return out;
}

function same(a: Row, b: Row): boolean {
  for (const key of Object.keys(b)) {
    if (String(a[key] ?? "") !== String(b[key] ?? "")) return false;
  }
  return true;
}

type ApplyResult = { applied: number; skipped: number; failed: number; people: boolean };

function applyOne(change: Change, result: ApplyResult): void {
  const handle = db();
  const spec = TABLES[change.tbl];
  if (!spec) {
    result.skipped += 1;
    return;
  }
  const where = spec.pk.map((column) => `${column} IS ?`).join(" AND ");

  if (change.row === null) {
    // A person deleted elsewhere (merged into another record there): if that
    // record is paired with one here, keep ours -- the merge runs here too.
    let pk = { ...change.pk };
    if (spec.person) {
      const local = mapped(spec.person.kind, pk["id"]);
      if (local !== pk["id"]) {
        result.skipped += 1;
        return;
      }
    }
    pk = translate(change.tbl, pk);
    const info = handle
      .prepare(`DELETE FROM ${change.tbl} WHERE ${where}`)
      .run(...spec.pk.map((column) => pk[column]));
    if (info.changes > 0) result.applied += 1;
    else result.skipped += 1;
    if (spec.person && info.changes > 0) result.people = true;
    return;
  }

  const columns = columnsOf(change.tbl);
  const row: Row = {};
  for (const [key, value] of Object.entries(translate(change.tbl, change.row))) {
    if (columns.has(key)) row[key] = value;
  }

  if (spec.person) {
    const kind = spec.person.kind;
    const foreignId = String(row["id"]);
    const local = mapped(kind, foreignId);
    if (local !== foreignId) row["id"] = local;
  }
  let existing = handle
    .prepare(`SELECT * FROM ${change.tbl} WHERE ${where}`)
    .get(...spec.pk.map((column) => row[column])) as Row | undefined;

  // Same person / same natural row under another id here: pair them.
  const naturalColumns = spec.person ? [spec.person.natural] : spec.natural;
  if (!existing && naturalColumns) {
    const byNatural = handle
      .prepare(
        `SELECT * FROM ${change.tbl} WHERE ${naturalColumns.map((column) => `${column} IS ?`).join(" AND ")}`,
      )
      .get(...naturalColumns.map((column) => row[column])) as Row | undefined;
    if (byNatural) {
      if (spec.person) {
        handle
          .prepare(
            `INSERT INTO peer_id_map (kind, foreign_id, local_id) VALUES (?, ?, ?)
             ON CONFLICT (kind, foreign_id) DO UPDATE SET local_id = excluded.local_id`,
          )
          .run(spec.person.kind, String(row["id"]), String(byNatural["id"]));
      }
      for (const column of spec.pk) row[column] = byNatural[column];
      existing = byNatural;
    }
  }

  if (existing) {
    if (same(existing, row)) {
      result.skipped += 1;
      return;
    }
    if (spec.lww && String(existing["updated_at"] ?? "") > String(row["updated_at"] ?? "")) {
      result.skipped += 1; // ours is newer
      return;
    }
  }

  const keys = Object.keys(row);
  const updates = keys.filter((key) => !spec.pk.includes(key));
  handle
    .prepare(
      `INSERT INTO ${change.tbl} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})
       ON CONFLICT (${spec.pk.join(", ")}) DO ${
         updates.length > 0
           ? `UPDATE SET ${updates.map((key) => `${key} = excluded.${key}`).join(", ")}`
           : "NOTHING"
       }`,
    )
    .run(...keys.map((key) => row[key] as never));
  result.applied += 1;
  if (spec.person) result.people = true;
}

/**
 * Apply changes from another computer, in one transaction. `origin` is that
 * computer on Main (its changes are recorded for the other members, marked as
 * its own); on a member it is null and nothing is recorded.
 */
export function applyChanges(changes: Change[], origin: string | null): ApplyResult {
  const handle = db();
  const result: ApplyResult = { applied: 0, skipped: 0, failed: 0, people: false };
  const run = handle.transaction(() => {
    handle
      .prepare("UPDATE sync_apply SET suppress = ?, origin = ? WHERE id = 1")
      .run(origin ? 0 : 1, origin);
    try {
      for (const change of changes) {
        const savepoint = "peer_row";
        handle.exec(`SAVEPOINT ${savepoint}`);
        try {
          applyOne(change, result);
          handle.exec(`RELEASE ${savepoint}`);
        } catch {
          // A row that cannot be applied (a reference this computer does not
          // have yet, a clash on a unique column) is skipped, not fatal: the
          // rest of the batch still arrives, and the row is sent again with its
          // next change.
          handle.exec(`ROLLBACK TO ${savepoint}`);
          handle.exec(`RELEASE ${savepoint}`);
          result.failed += 1;
        }
      }
    } finally {
      handle.prepare("UPDATE sync_apply SET suppress = 0, origin = NULL WHERE id = 1").run();
    }
  });
  run();
  return result;
}

/** After people changed: read results with today's master lists. */
async function afterPeopleChanged(people: boolean): Promise<void> {
  const { markStale } = await import("@/server/rematch");
  markStale("staff");
  markStale("student");
  if (!people) return;
  const admin = db()
    .prepare("SELECT user_id FROM user_roles WHERE role = 'admin' ORDER BY updated_at LIMIT 1")
    .get() as { user_id: string } | undefined;
  if (!admin) return;
  const { deduplicateEveryone } = await import("@/server/masters");
  await deduplicateEveryone(admin.user_id);
}

// Main: the network side ------------------------------------------------------------

type Services = {
  server: http.Server | null;
  discovery: dgram.Socket | null;
  timer: ReturnType<typeof setInterval> | null;
  syncing: Promise<PeerSyncSummary> | null;
};
const services: Services = ((globalThis as Record<string, unknown>)["__attendancePeer"] ??= {
  server: null,
  discovery: null,
  timer: null,
  syncing: null,
}) as Services;

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 200 * 1024 * 1024) {
        reject(new Error("too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    // One request per connection: an idle connection left open by a member
    // would otherwise keep this app running after it is closed.
    connection: "close",
  });
  response.end(text);
}

function noteDevice(id: string, name: string | null, address: string | undefined): void {
  db()
    .prepare(
      `INSERT INTO peer_devices (device_id, device_name, address, last_seen_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT (device_id) DO UPDATE SET device_name = excluded.device_name,
         address = excluded.address, last_seen_at = excluded.last_seen_at`,
    )
    .run(id, name, address ?? null);
}

async function handlePeer(
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://peer");
  const current = settings();
  if (current.role !== "main") return send(response, 503, { error: "This computer is not Main." });
  if (String(request.headers["x-pairing-code"] ?? "") !== current.pairing_code) {
    return send(response, 401, { error: "Wrong pairing code." });
  }
  const device = String(request.headers["x-device-id"] ?? "");
  const name = String(request.headers["x-device-name"] ?? "") || null;
  if (!device) return send(response, 400, { error: "Missing device." });
  noteDevice(device, name, request.socket.remoteAddress);

  if (url.pathname === "/peer/hello") {
    return send(response, 200, {
      deviceId: current.device_id,
      name: deviceName(),
      schemaVersion: schemaVersion(),
    });
  }
  if (url.pathname === "/peer/push" && request.method === "POST") {
    const body = JSON.parse(await readBody(request)) as { changes: Change[] };
    const result = applyChanges(body.changes ?? [], device);
    if (result.applied > 0) await afterPeopleChanged(result.people);
    return send(response, 200, result);
  }
  if (url.pathname === "/peer/pull") {
    const since = Number(url.searchParams.get("since") ?? "0") || 0;
    return send(response, 200, readChanges({ since, exceptOrigin: device }));
  }
  return send(response, 404, { error: "Unknown request." });
}

function startMainServices(): void {
  if (!services.server) {
    const server = http.createServer((request, response) => {
      handlePeer(request, response).catch((error: unknown) =>
        send(response, 500, { error: (error as Error).message }),
      );
    });
    server.on("error", (error) => {
      saveSettings({
        last_error: `Could not listen for other computers: ${(error as Error).message}`,
      });
      services.server = null;
    });
    // Every network the computer is on, so members on the office network reach it.
    server.keepAliveTimeout = 1000;
    server.listen(PEER_PORT, "0.0.0.0");
    // Never the reason the app stays running: when the app is closed, this goes too.
    server.unref();
    services.server = server;
  }
  if (!services.discovery) {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    socket.on("message", (message, remote) => {
      if (message.toString() !== DISCOVER_MESSAGE) return;
      const reply = JSON.stringify({
        app: "attendance-register",
        name: deviceName(),
        deviceId: settings().device_id,
        port: PEER_PORT,
      });
      socket.send(reply, remote.port, remote.address);
    });
    socket.on("error", () => {
      socket.close();
      services.discovery = null;
    });
    socket.bind(DISCOVERY_PORT, "0.0.0.0", () => socket.unref());
    services.discovery = socket;
  }
}

function stopMainServices(): void {
  services.server?.close();
  services.server = null;
  services.discovery?.close();
  services.discovery = null;
}

// Member: finding Main and syncing -------------------------------------------------

/** Ask the office network who is Main. Takes about two seconds. */
export async function discoverMain(): Promise<FoundMain[]> {
  const targets = new Set<string>(["255.255.255.255"]);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family !== "IPv4" || address.internal) continue;
      const ip = address.address.split(".").map(Number);
      const mask = address.netmask.split(".").map(Number);
      targets.add(ip.map((part, index) => (part & mask[index]!) | (~mask[index]! & 255)).join("."));
    }
  }
  const found = new Map<string, FoundMain>();
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve) => socket.bind(0, () => resolve()));
  socket.setBroadcast(true);
  socket.on("message", (message, remote) => {
    try {
      const reply = JSON.parse(message.toString()) as {
        app?: string;
        name?: string;
        deviceId?: string;
      };
      if (reply.app !== "attendance-register" || !reply.deviceId) return;
      if (reply.deviceId === settings().device_id) return;
      found.set(reply.deviceId, {
        name: reply.name ?? remote.address,
        address: remote.address,
        deviceId: reply.deviceId,
      });
    } catch {
      // not ours
    }
  });
  for (const target of targets) socket.send(DISCOVER_MESSAGE, DISCOVERY_PORT, target);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  socket.close();
  return [...found.values()];
}

async function callMain<T>(
  current: Settings,
  path: string,
  init: { method?: string; body?: unknown; code?: string; address?: string } = {},
): Promise<T> {
  const address = init.address ?? current.main_address;
  if (!address) throw new HttpError(400, "This computer has not joined a Main computer.");
  let response: Response;
  try {
    response = await fetch(`http://${address}:${PEER_PORT}${path}`, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        "x-pairing-code": init.code ?? current.pairing_code ?? "",
        "x-device-id": current.device_id,
        "x-device-name": deviceName(),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    throw new HttpError(
      502,
      "Could not reach the Main computer. Check that it is on, that the Attendance Register app is open on it, and that both computers are on the same network.",
    );
  }
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (response.status === 401) {
    throw new HttpError(
      401,
      "The Main computer did not accept the pairing code. Check the code shown on Main.",
    );
  }
  if (!response.ok) throw new HttpError(502, payload.error ?? `Main answered ${response.status}.`);
  return payload as T;
}

async function runSync(): Promise<PeerSyncSummary> {
  const current = settings();
  if (current.role !== "member") {
    throw new HttpError(400, "Only a computer that has joined a Main computer synchronizes.");
  }
  const at = new Date().toISOString();
  try {
    const hello = await callMain<{ deviceId: string; name: string; schemaVersion: number }>(
      current,
      "/peer/hello",
    );
    if (hello.schemaVersion !== schemaVersion()) {
      throw new HttpError(
        409,
        `This computer and the Main computer have different versions of the app (${schemaVersion()} here, ${hello.schemaVersion} on Main). Install the same version on both.`,
      );
    }
    saveSettings({ main_name: hello.name, main_device_id: hello.deviceId });

    // 1. What changed here goes to Main.
    let sent = 0;
    let pushed = current.pushed_seq;
    for (;;) {
      const batch = readChanges({ since: pushed, onlyLocal: true });
      if (batch.changes.length > 0) {
        await callMain(current, "/peer/push", { method: "POST", body: { changes: batch.changes } });
        sent += batch.changes.length;
      }
      pushed = batch.last;
      saveSettings({ pushed_seq: pushed });
      if (!batch.more) break;
    }

    // 2. What changed everywhere else comes back.
    let received = 0;
    let people = false;
    let pulled = current.pulled_seq;
    for (;;) {
      const batch = await callMain<{ changes: Change[]; last: number; more: boolean }>(
        current,
        `/peer/pull?since=${pulled}`,
      );
      if (batch.changes.length > 0) {
        const result = applyChanges(batch.changes, null);
        received += result.applied;
        people ||= result.people;
      }
      pulled = batch.last;
      saveSettings({ pulled_seq: pulled });
      if (!batch.more) break;
    }
    if (received > 0) await afterPeopleChanged(people);

    const message =
      sent + received === 0
        ? "Everything was already up to date."
        : `Sent ${sent} change(s), received ${received}.`;
    saveSettings({ last_sync_at: at, last_result: message, last_error: null });
    return { ok: true, sent, received, at, message };
  } catch (error) {
    const message = (error as Error).message;
    saveSettings({ last_error: message });
    throw error;
  }
}

/** One sync at a time; a second request waits for the running one. */
export function syncNow(): Promise<PeerSyncSummary> {
  if (!services.syncing) {
    services.syncing = runSync().finally(() => {
      services.syncing = null;
    });
  }
  return services.syncing;
}

function startMemberServices(): void {
  if (services.timer) return;
  services.timer = setInterval(() => {
    void syncNow().catch(() => undefined);
  }, AUTO_SYNC_MS);
  services.timer.unref();
  // Soon after the app opens, catch up.
  setTimeout(() => void syncNow().catch(() => undefined), 15_000).unref();
}

function stopMemberServices(): void {
  if (services.timer) clearInterval(services.timer);
  services.timer = null;
}

/** Start whatever this computer's role needs. Safe to call any number of times. */
export function ensurePeerServices(): void {
  if (activeDriver() !== "sqlite") return;
  const role = settings().role;
  if (role === "main") {
    stopMemberServices();
    startMainServices();
  } else if (role === "member") {
    stopMainServices();
    startMemberServices();
  } else {
    stopMainServices();
    stopMemberServices();
  }
}

// What the sync screen shows and does -------------------------------------------------

function lanAddresses(): string[] {
  const out: string[] = [];
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal) out.push(address.address);
    }
  }
  return out;
}

export function peerStatus(): PeerStatus {
  ensurePeerServices();
  const current = settings();
  const pending = (
    db()
      .prepare("SELECT COUNT(*) AS n FROM change_log WHERE seq > ? AND origin IS NULL")
      .get(current.pushed_seq) as { n: number }
  ).n;
  const devices = (
    db()
      .prepare(
        "SELECT device_name, address, last_seen_at FROM peer_devices ORDER BY last_seen_at DESC",
      )
      .all() as Array<{
      device_name: string | null;
      address: string | null;
      last_seen_at: string | null;
    }>
  ).map((row) => ({
    name: row.device_name,
    address: row.address?.replace(/^::ffff:/, "") ?? null,
    lastSeenAt: row.last_seen_at,
  }));
  return {
    role: current.role,
    deviceName: deviceName(),
    addresses: lanAddresses(),
    pairingCode: current.role === "main" ? current.pairing_code : null,
    main:
      current.role === "member" ? { name: current.main_name, address: current.main_address } : null,
    devices: current.role === "main" ? devices : [],
    lastSyncAt: current.last_sync_at,
    lastResult: current.last_result,
    lastError: current.last_error,
    pending: current.role === "member" ? pending : 0,
    syncing: services.syncing !== null,
    listening: services.server !== null,
  };
}

/** Make this computer Main (a new pairing code each time). */
export function becomeMain(): PeerStatus {
  saveSettings({
    role: "main",
    pairing_code: String(randomInt(0, 1_000_000)).padStart(6, "0"),
    main_address: null,
    main_name: null,
    main_device_id: null,
    last_error: null,
  });
  ensurePeerServices();
  return peerStatus();
}

/** Join a Main computer: check the address and code, then take the first sync. */
export async function joinMain(input: { address: string; code: string }): Promise<PeerStatus> {
  const address = input.address.trim();
  const code = input.code.replace(/\D/g, "");
  if (!address) throw new HttpError(400, "Choose the Main computer.");
  if (code.length !== 6)
    throw new HttpError(400, "Enter the 6-digit code shown on the Main computer.");
  const current = settings();
  const hello = await callMain<{ deviceId: string; name: string; schemaVersion: number }>(
    current,
    "/peer/hello",
    { code, address },
  );
  if (hello.deviceId === current.device_id) {
    throw new HttpError(400, "That is this computer. Choose the Main computer.");
  }
  // A different Main (or the first one): start both directions from the beginning.
  const restart = current.main_device_id !== hello.deviceId;
  saveSettings({
    role: "member",
    pairing_code: code,
    main_address: address,
    main_name: hello.name,
    main_device_id: hello.deviceId,
    ...(restart ? { pushed_seq: 0, pulled_seq: 0 } : {}),
    last_error: null,
  });
  ensurePeerServices();
  void syncNow().catch(() => undefined);
  return peerStatus();
}

/** Stop syncing (this computer keeps all its data). */
export function leaveSync(): PeerStatus {
  saveSettings({ role: "off", pairing_code: null, last_error: null });
  ensurePeerServices();
  return peerStatus();
}

export function renameDevice(name: string): PeerStatus {
  saveSettings({ device_name: name.trim().slice(0, 60) || null });
  return peerStatus();
}
