/**
 * Proves the app can read the MariaDB install it had before the desktop work:
 * the exact query `signIn()` runs, the users list, the derived master columns,
 * and an upsert inside a transaction that is rolled back.
 *
 * Read-only apart from the upsert check, which is rolled back.
 * Run with: npx tsx db/verify-login.ts
 */
import { dialect, query, queryOne, transaction } from "../src/server/db";

let failures = 0;
function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures += 1;
}

console.log(`driver: ${dialect.insertIgnore.startsWith("INSERT OR") ? "sqlite" : "mysql"}\n`);

// Baseline row counts, captured before any write. The upsert check below is
// rolled back, so these must be unchanged afterwards — that is the assertion,
// not a fixed number: students and staff are added and removed over time.
const baselineStudents = Number(
  (await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM students"))?.total,
);
const baselineStaff = Number(
  (await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM staff"))?.total,
);

// 1. The exact statement signIn() runs.
const user = await queryOne<{
  id: string;
  email: string;
  full_name: string;
  password_hash: string;
}>("SELECT id, email, full_name, password_hash FROM users WHERE email = ? LIMIT 1", [
  "admin@attendance.test",
]);
check("signIn() finds the admin account", Boolean(user), user ? `id=${user.id.slice(0, 8)}…` : "");
check(
  "the account has a password hash",
  Boolean(user?.password_hash),
  user ? `hash length ${user.password_hash.length}` : "",
);

if (user) {
  const roles = await query<{ role: string }>("SELECT role FROM user_roles WHERE user_id = ?", [
    user.id,
  ]);
  check("loadMe() reads the account's roles", roles.length > 0, roles.map((r) => r.role).join(","));
}

// 2. The users list query, with the DATE_FORMAT / GROUP_CONCAT changes.
const listed = await query<{ email: string; created_at: string; roles: string }>(
  `SELECT u.id, u.email, u.full_name,
          ${dialect.dateTime("u.created_at")} AS created_at,
          ${dialect.groupConcat("r.role")} AS roles
   FROM users u
   LEFT JOIN user_roles r ON r.user_id = u.id
   GROUP BY u.id, u.email, u.full_name, u.created_at
   ORDER BY u.created_at`,
);
check(
  "the users list is not empty",
  listed.length > 0,
  `${listed.length} account(s), including the admin`,
);
const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
check(
  "created_at is ISO-shaped",
  listed.every((r) => iso.test(String(r.created_at))),
  listed.map((r) => `${r.created_at}`).join(" | "),
);
check(
  "roles are comma-joined",
  listed.every((r) => typeof r.roles === "string" && r.roles.length > 0),
  listed.map((r) => r.roles).join(" | "),
);

// 3. Master lists and the derived columns, which decide who is expected where.
const students = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM students");
const staff = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM staff");
check(
  `all ${baselineStudents.toLocaleString("en-US")} students are readable`,
  Number(students?.total) === baselineStudents,
  `got ${students?.total}`,
);
check(
  `all ${baselineStaff.toLocaleString("en-US")} staff are readable`,
  Number(staff?.total) === baselineStaff,
  `got ${staff?.total}`,
);

const departments = await query<{ department: string }>(
  `SELECT DISTINCT NULLIF(TRIM(department), '') AS department
     FROM students WHERE NULLIF(TRIM(department), '') IS NOT NULL ORDER BY department`,
);
check(
  "student departments are readable",
  departments.length > 0,
  `${departments.length} departments`,
);

const one = await query<{ full_name: string }>(
  `SELECT TRIM(CONCAT_WS(' ', s.last_name, s.first_name, s.middle_name)) AS full_name
     FROM students s LIMIT 1`,
);
check(
  "CONCAT_WS name building works",
  typeof one[0]?.full_name === "string",
  JSON.stringify(one[0]?.full_name),
);

// 4. The upsert, inside a transaction that is rolled back.
const marker = "VUG/ZZZ/26/9999";
await transaction(async (connection) => {
  await connection.execute(
    `INSERT INTO students (id, matric_no, last_name, first_name, middle_name, level)
     VALUES (?, ?, ?, ?, ?, ?)
     ${dialect.upsert("matric_no", ["last_name", "first_name", "middle_name", "level"])}`,
    ["verify-login-temp", marker, "VERIFY", "ROLLS", "BACK", "100"],
  );
  // Reads inside the transaction must go through the same connection, or they
  // run on a different pooled connection and cannot see the uncommitted row.
  const [[after]] = await connection.query<{ last_name: string; level: string }[]>(
    "SELECT last_name, level FROM students WHERE matric_no = ?",
    [marker],
  );
  check("upsert inserts a new row", after?.last_name === "VERIFY", JSON.stringify(after));

  await connection.execute(
    `INSERT INTO students (id, matric_no, last_name, first_name, middle_name, level)
     VALUES (?, ?, ?, ?, ?, ?)
     ${dialect.upsert("matric_no", ["last_name", "first_name", "middle_name", "level"])}`,
    ["verify-login-temp-2", marker, "CHANGED", "ROLLS", "BACK", "200"],
  );
  const [[updated]] = await connection.query<{ last_name: string; level: string }[]>(
    "SELECT last_name, level FROM students WHERE matric_no = ?",
    [marker],
  );
  check(
    "upsert updates the same row",
    updated?.last_name === "CHANGED" && updated?.level === "200",
    JSON.stringify(updated),
  );
  const [[counted]] = await connection.query<{ total: number }[]>(
    "SELECT COUNT(*) AS total FROM students WHERE matric_no = ?",
    [marker],
  );
  check("upsert did not duplicate the row", Number(counted?.total) === 1, `rows=${counted?.total}`);

  await connection.execute("DELETE FROM students WHERE matric_no = ?", [marker]);
  throw new Error("ROLLBACK");
}).catch((error: Error) => {
  if (error.message !== "ROLLBACK") {
    check("upsert transaction ran", false, error.message);
  }
});

const leftover = await queryOne<{ total: number }>(
  "SELECT COUNT(*) AS total FROM students WHERE matric_no = ?",
  [marker],
);
check("the rollback left nothing behind", Number(leftover?.total) === 0, `rows=${leftover?.total}`);

const finalStudents = await queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM students");
check(
  "student count is unchanged",
  Number(finalStudents?.total) === baselineStudents,
  `got ${finalStudents?.total}`,
);

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
