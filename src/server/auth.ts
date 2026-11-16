import { compare, hash } from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import {
  deleteCookie,
  getCookie,
  getRequestProtocol,
  setCookie,
} from "@tanstack/react-start/server";
import { randomUUID } from "node:crypto";
import process from "node:process";
import type { RowDataPacket } from "./db";
import { query, queryOne, transaction, utcStamp } from "@/server/db";
import { loadServerEnv } from "@/server/env";
import { HttpError } from "@/server/http";
import type { AppRole, Me } from "@/lib/types";

const COOKIE_NAME = "attendance_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const BCRYPT_ROUNDS = 10;

type UserRow = RowDataPacket & {
  id: string;
  email: string;
  full_name: string | null;
  password_hash: string;
};

type RoleRow = RowDataPacket & { role: AppRole };
type CountRow = RowDataPacket & { total: number };

function sessionSecret(): Uint8Array {
  loadServerEnv();
  const secret = process.env["SESSION_SECRET"];
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET is missing or shorter than 32 characters. Fix it in .env.");
  }
  return new TextEncoder().encode(secret);
}

export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function hashPassword(password: string): Promise<string> {
  return hash(password, BCRYPT_ROUNDS);
}

async function loadMe(userId: string): Promise<Me | null> {
  const user = await queryOne<UserRow>(
    "SELECT id, email, full_name, password_hash FROM users WHERE id = ? LIMIT 1",
    [userId],
  );
  if (!user) return null;
  const roles = await query<RoleRow>("SELECT role FROM user_roles WHERE user_id = ?", [userId]);
  return {
    user: { id: user.id, email: user.email, fullName: user.full_name },
    roles: roles.map((row) => row.role),
  };
}

/** First account created becomes the administrator, everyone after that a viewer. */
export async function createAccount(input: {
  email: string;
  password: string;
  fullName: string | null;
}): Promise<Me> {
  const email = normaliseEmail(input.email);
  const existing = await queryOne<CountRow>("SELECT COUNT(*) AS total FROM users WHERE email = ?", [
    email,
  ]);
  if ((existing?.total ?? 0) > 0) {
    throw new HttpError(409, "An account with that email already exists.");
  }

  const passwordHash = await hashPassword(input.password);
  const userId = randomUUID();

  const me = await transaction(async (connection) => {
    const now = utcStamp();
    await connection.execute(
      "INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES (?, ?, ?, ?, ?)",
      [userId, email, passwordHash, input.fullName, now],
    );
    await connection.execute(
      "INSERT INTO profiles (id, full_name, email, updated_at) VALUES (?, ?, ?, ?)",
      [userId, input.fullName, email, now],
    );

    const [roleRows] = await connection.query<CountRow[]>(
      "SELECT COUNT(*) AS total FROM user_roles",
    );
    const isFirstUser = (roleRows[0]?.total ?? 0) === 0;
    const role: AppRole = isFirstUser ? "admin" : "viewer";

    await connection.execute(
      "INSERT INTO user_roles (id, user_id, role, updated_at) VALUES (?, ?, ?, ?)",
      [randomUUID(), userId, role, now],
    );
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)",
      [randomUUID(), userId, "account.created", "users", userId],
    );

    return {
      user: { id: userId, email, fullName: input.fullName },
      roles: [role],
    } satisfies Me;
  });

  await startSession(me);
  return me;
}

export async function signIn(email: string, password: string): Promise<Me> {
  await ensureDefaultAdmins();
  const user = await queryOne<UserRow>(
    "SELECT id, email, full_name, password_hash FROM users WHERE email = ? LIMIT 1",
    [normaliseEmail(email)],
  );
  // Same message either way so the form cannot be used to discover registered emails.
  const invalid = new HttpError(401, "That email and password do not match an account.");
  if (!user) throw invalid;

  const matches = await compare(password, user.password_hash);
  if (!matches) throw invalid;

  const me = await loadMe(user.id);
  if (!me) throw invalid;
  await startSession(me);
  return me;
}

export async function getSession(): Promise<Me | null> {
  const token = getCookie(COOKIE_NAME);
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, sessionSecret(), { algorithms: ["HS256"] });
    const userId = payload["sub"];
    if (typeof userId !== "string") return null;
    return await loadMe(userId);
  } catch {
    return null;
  }
}

/** Check whether the system has been initialised (at least one admin exists). */
export async function isSetupComplete(): Promise<boolean> {
  const row = await queryOne<CountRow>(
    "SELECT COUNT(*) AS total FROM user_roles WHERE role = 'admin'",
  );
  return (row?.total ?? 0) > 0;
}

export async function requireSession(): Promise<Me> {
  const session = await getSession();
  if (!session) throw new HttpError(401, "You need to sign in first.");
  return session;
}

export function canEdit(session: Me): boolean {
  return session.roles.includes("admin") || session.roles.includes("operator");
}

export function requireEditor(session: Me): void {
  if (!canEdit(session)) {
    throw new HttpError(403, "Your role can view records but not change them.");
  }
}

export function requireAdmin(session: Me): void {
  if (!session.roles.includes("admin")) {
    throw new HttpError(403, "Only administrators can do that.");
  }
}

export async function startSession(me: Me): Promise<void> {
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(me.user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE_SECONDS}s`)
    .sign(sessionSecret());

  setCookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
    secure: getRequestProtocol() === "https",
  });
}

export function endSession(): void {
  deleteCookie(COOKIE_NAME, { path: "/" });
}

// Built-in administrators -------------------------------------------------------
//
// Every installation has these administrator accounts, so the office can sign in
// on a new computer straight away. An account is only created when its email is
// not there yet: a password or role changed later is never put back.
const DEFAULT_ADMINS: Array<{ email: string; fullName: string }> = [
  { email: "bassan@veritas.edu.ng", fullName: "Bassan" },
  { email: "tapiyadi@veritas.edu.ng", fullName: "Tapiyadi" },
];
const DEFAULT_PASSWORD = "welcome@123";
let defaultAdminsChecked: Promise<void> | null = null;

/** Create the built-in administrators that are missing. Runs once per start. */
export function ensureDefaultAdmins(): Promise<void> {
  defaultAdminsChecked ??= (async () => {
    for (const admin of DEFAULT_ADMINS) {
      const email = normaliseEmail(admin.email);
      const found = await queryOne<CountRow>(
        "SELECT COUNT(*) AS total FROM users WHERE email = ?",
        [email],
      );
      if (Number(found?.total ?? 0) > 0) continue;
      const userId = randomUUID();
      const passwordHash = await hashPassword(DEFAULT_PASSWORD);
      await transaction(async (connection) => {
        const now = utcStamp();
        await connection.execute(
          "INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES (?, ?, ?, ?, ?)",
          [userId, email, passwordHash, admin.fullName, now],
        );
        await connection.execute(
          "INSERT INTO profiles (id, full_name, email, updated_at) VALUES (?, ?, ?, ?)",
          [userId, admin.fullName, email, now],
        );
        await connection.execute(
          "INSERT INTO user_roles (id, user_id, role, updated_at) VALUES (?, ?, ?, ?)",
          [randomUUID(), userId, "admin", now],
        );
        await connection.execute(
          "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)",
          [randomUUID(), null, "account.built_in_admin", "users", userId],
        );
      });
    }
  })().catch((error: unknown) => {
    defaultAdminsChecked = null;
    throw error;
  });
  return defaultAdminsChecked;
}

// Changing accounts --------------------------------------------------------------

async function emailTaken(email: string, exceptId: string): Promise<boolean> {
  const row = await queryOne<CountRow>(
    "SELECT COUNT(*) AS total FROM users WHERE email = ? AND id <> ?",
    [email, exceptId],
  );
  return Number(row?.total ?? 0) > 0;
}

/**
 * Change an account's name, email or password. An administrator can change
 * anyone's; everyone else only their own, and changing your own password or
 * email needs your current password.
 */
export async function updateAccount(
  session: Me,
  input: {
    userId: string;
    email?: string | undefined;
    fullName?: string | null | undefined;
    password?: string | undefined;
    currentPassword?: string | undefined;
  },
): Promise<void> {
  const self = input.userId === session.user.id;
  const admin = session.roles.includes("admin");
  if (!self && !admin) throw new HttpError(403, "Only an administrator can change other accounts.");
  const user = await queryOne<UserRow>(
    "SELECT id, email, full_name, password_hash FROM users WHERE id = ? LIMIT 1",
    [input.userId],
  );
  if (!user) throw new HttpError(404, "That user no longer exists.");

  const email = input.email !== undefined ? normaliseEmail(input.email) : undefined;
  if (email !== undefined && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new HttpError(400, "That does not look like an email address.");
  }
  if (input.password !== undefined && input.password.length < 6) {
    throw new HttpError(400, "The new password must be at least 6 characters.");
  }
  const changingSecret =
    (email !== undefined && email !== user.email) || input.password !== undefined;
  if (self && changingSecret) {
    if (!input.currentPassword || !(await compare(input.currentPassword, user.password_hash))) {
      throw new HttpError(400, "Your current password is not correct.");
    }
  }
  if (email !== undefined && email !== user.email && (await emailTaken(email, user.id))) {
    throw new HttpError(409, "Another account already uses that email.");
  }

  const sets: string[] = [];
  const values: unknown[] = [];
  if (email !== undefined && email !== user.email) {
    sets.push("email = ?");
    values.push(email);
  }
  if (input.fullName !== undefined) {
    sets.push("full_name = ?");
    values.push(input.fullName?.trim() || null);
  }
  if (input.password !== undefined) {
    sets.push("password_hash = ?");
    values.push(await hashPassword(input.password));
  }
  if (sets.length === 0) return;
  const now = utcStamp();
  await transaction(async (connection) => {
    await connection.execute(`UPDATE users SET ${sets.join(", ")}, updated_at = ? WHERE id = ?`, [
      ...(values as Array<string | null>),
      now,
      user.id,
    ]);
    await connection.execute(
      "UPDATE profiles SET email = ?, full_name = ?, updated_at = ? WHERE id = ?",
      [
        email ?? user.email,
        input.fullName !== undefined ? input.fullName?.trim() || null : user.full_name,
        now,
        user.id,
      ],
    );
    await connection.execute(
      "INSERT INTO audit_logs (id, actor_id, action, entity, entity_id, details) VALUES (?, ?, ?, ?, ?, ?)",
      [
        randomUUID(),
        session.user.id,
        "account.updated",
        "users",
        user.id,
        JSON.stringify({
          email: email !== undefined && email !== user.email,
          name: input.fullName !== undefined,
          password: input.password !== undefined,
        }),
      ],
    );
  });
  // Your own new email shows at once.
  if (self) {
    const me = await loadMe(user.id);
    if (me) await startSession(me);
  }
}
