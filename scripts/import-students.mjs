import fs from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";

const env = Object.fromEntries(
  fs
    .readFileSync(resolve(import.meta.dirname, "..", ".env"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
    .map((l) => {
      const at = l.indexOf("=");
      return [l.slice(0, at).trim(), l.slice(at + 1).trim()];
    }),
);

function readCsv(path) {
  const text = fs.readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let f = "";
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          f += '"';
          i += 1;
        } else q = false;
      } else f += c;
      continue;
    }
    if (c === '"') q = true;
    else if (c === ",") {
      row.push(f);
      f = "";
    } else if (c === "\n") {
      row.push(f);
      rows.push(row);
      row = [];
      f = "";
    } else if (c !== "\r") f += c;
  }
  if (f !== "" || row.length > 0) {
    row.push(f);
    rows.push(row);
  }
  const head = rows.shift().map((h) => h.trim().toLowerCase());
  return rows
    .filter((c) => c.some((x) => x.trim() !== ""))
    .map((c) => Object.fromEntries(head.map((h, i) => [h, (c[i] ?? "").trim()])));
}

function nullIfBlank(v) {
  if (v == null) return null;
  const t = v.trim();
  if (!t) return null;
  if (/^(null|n\/?a|none|not applicable)$/i.test(t)) return null;
  return t;
}

async function main() {
  const rows = readCsv("C:\\Users\\Student Affairs\\Downloads\\CODE\\Attendancee\\student_db.csv");
  console.log(`Read ${rows.length} rows from CSV`);

  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: Number(env.DB_PORT),
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    database: env.DB_NAME,
  });

  console.log("Clearing existing students...");
  await conn.query("DELETE FROM students");

  const BATCH = 500;
  let saved = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const records = batch.map((r) => ({
      matricNo: nullIfBlank(r.matric_no),
      lastName: nullIfBlank(r.lname),
      firstName: nullIfBlank(r.fname),
      middleName: nullIfBlank(r.mname),
      level: nullIfBlank(r.level),
    }));

    if (records.length > 0) {
      const values = records.flatMap((r) => [
        randomUUID(),
        r.matricNo,
        r.lastName,
        r.firstName,
        r.middleName,
        r.level,
      ]);
      const ph = records.map(() => "(?,?,?,?,?,?)").join(",");
      await conn.query(
        `INSERT INTO students (id, matric_no, last_name, first_name, middle_name, level) VALUES ${ph}`,
        values,
      );
      saved += records.length;
    }
    console.log(`Batch ${Math.floor(i / 500) + 1}: saved ${saved}`);
  }
  const [cnt] = await conn.query("SELECT COUNT(*) n FROM students");
  console.log(`\nDone. Total students: ${cnt[0].n}`);
  await conn.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
