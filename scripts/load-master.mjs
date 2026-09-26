// Loads the registrar's master CSVs through the running app's own import API,
// so the data arrives exactly the way an admin upload would put it there.
//
// Start the app yourself first (npm run dev, or npm start), then:
//
//   node scripts/load-master.mjs
//   PORT=3000 node scripts/load-master.mjs
//   node scripts/load-master.mjs --with-scans   also test scan matching
//
// The script never starts or stops the server.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const BASE = process.env.BASE ?? `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const EMAIL = process.env.EMAIL ?? "admin@attendance.test";
const PASSWORD = process.env.PASSWORD ?? "correct-horse-1";
const ROOT = resolve(import.meta.dirname, "..");
const SOURCE_DIR = resolve(ROOT, "..");
const WITH_SCANS = process.argv.includes("--with-scans");
const BATCH = 500;

/** Quote-aware CSV reader: the master files quote every field and the machine
 *  files contain newlines inside names, so splitting on lines is not safe. */
function readCsv(path) {
  const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const head = rows.shift().map((cell) => cell.trim().toLowerCase());
  return rows
    .filter((cells) => cells.some((cell) => cell.trim() !== ""))
    .map((cells) =>
      Object.fromEntries(head.map((key, index) => [key, (cells[index] ?? "").trim()])),
    );
}

let cookie = "";

async function call(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...init.headers },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }
  if (!response.ok) {
    throw new Error(
      `${init.method ?? "GET"} ${path} -> ${response.status} ${String(text).slice(0, 300)}`,
    );
  }
  return payload;
}

async function requireServer() {
  // /api/auth/me answers 401 while signed out, which still proves the app is
  // up, so any HTTP response counts. Only a refused connection means "not up".
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await fetch(`${BASE}/api/auth/me`);
      return;
    } catch (error) {
      if (attempt === 9) {
        throw new Error(
          `No app answering at ${BASE}. Start it yourself (npm run dev) and run this again. (${error.message})`,
        );
      }
      await new Promise((done) => setTimeout(done, 500));
    }
  }
}

const created = [];

try {
  await requireServer();
  await call("/api/auth/signin", {
    method: "POST",
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  console.log(`signed in as ${EMAIL} against ${BASE}`);

  const students = readCsv(resolve(SOURCE_DIR, "student_db.csv"));
  const staff = readCsv(resolve(SOURCE_DIR, "staff_db.csv"));
  console.log(`csv rows: ${students.length} students, ${staff.length} staff`);

  let saved = 0;
  let skipped = 0;
  for (let index = 0; index < students.length; index += BATCH) {
    const records = students.slice(index, index + BATCH).map((row) => ({
      matricNo: row.matric_no,
      lastName: row.lname,
      firstName: row.fname,
      middleName: row.mname,
      level: row.level,
    }));
    const result = await call("/api/students/import", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    saved += result.saved;
    skipped += result.skipped;
  }
  console.log(`students saved ${saved}, skipped ${skipped}`);

  saved = 0;
  skipped = 0;
  for (let index = 0; index < staff.length; index += BATCH) {
    const records = staff.slice(index, index + BATCH).map((row) => ({
      staffNo: row.staff_no,
      lastName: row.lname,
      firstName: row.fname,
      middleName: row.mname,
    }));
    const result = await call("/api/staff/import", {
      method: "POST",
      body: JSON.stringify({ records }),
    });
    saved += result.saved;
    skipped += result.skipped;
  }
  console.log(`staff saved ${saved}, skipped ${skipped}`);

  const studentList = await call("/api/students?limit=1");
  const staffList = await call("/api/staff?limit=1");
  const departments = await call("/api/departments");
  console.log(
    `students total ${studentList.total} (UG ${studentList.undergraduate}, PG ${studentList.postgraduate}), ` +
      `staff total ${staffList.total}, levels ${studentList.levels.length}, ` +
      `departments ${departments.length}`,
  );

  if (WITH_SCANS) {
    for (const [file, group] of [
      ["Machine_data.csv", "student"],
      ["Machine_data2.csv", "student"],
      ["Machine_data.csv", "staff"],
    ]) {
      const rows = readCsv(resolve(SOURCE_DIR, file)).map((row) => ({
        scanNumber: row.id,
        name: row.name,
        scannedAt: row.time,
      }));
      const event = await call(`/api/${group}-events`, {
        method: "POST",
        body: JSON.stringify({ title: `CHECK ${group} ${file}`, eventDate: "2026-09-02" }),
      });
      created.push([group, event.id]);
      const uploaded = await call(`/api/${group}-events/${event.id}/uploads`, {
        method: "POST",
        body: JSON.stringify({ fileName: file, label: "check", rows }),
      });
      const summary = uploaded.summary;
      console.log(
        `${group} ${file}: rows ${uploaded.upload.row_count}, expected ${summary.expected}, ` +
          `present ${summary.present}, absent ${summary.absent}, out of scope ${summary.outOfScope}, ` +
          `unmatched ${summary.unmatched}, percent ${summary.percent}`,
      );
    }
  }
} catch (error) {
  console.error("FAILED:", error.message);
  process.exitCode = 1;
} finally {
  for (const [group, eventId] of created) {
    try {
      await call(`/api/${group}-events/${eventId}`, { method: "DELETE" });
      console.log(`removed check event ${group} ${eventId}`);
    } catch (error) {
      console.error(`could not remove check event ${group} ${eventId}:`, error.message);
    }
  }
}
