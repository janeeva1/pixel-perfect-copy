const D = require('better-sqlite3');
const { randomUUID } = require('crypto');
const db = new D('db/seed/attendance.db');

const staffDepts = db.prepare("SELECT DISTINCT COALESCE(NULLIF(TRIM(department), ''), NULLIF(TRIM(admin_department), '')) AS department FROM staff WHERE COALESCE(NULLIF(TRIM(department), ''), NULLIF(TRIM(admin_department), '')) IS NOT NULL ORDER BY department").all();

const existing = db.prepare("SELECT department_code, day_of_week FROM mass_department_weekdays WHERE is_active = 1").all();
const existingByDept = new Map(existing.map((r) => [r.department_code.trim().toLowerCase(), r.day_of_week]));

const daysUsed = Array.from(existingByDept.values());
let nextDay = 1;
while (daysUsed.includes(nextDay)) nextDay = (nextDay % 5) + 1;

const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');

let sql = '';
let added = 0;
for (const row of staffDepts) {
  const dept = row.department.trim();
  const key = dept.toLowerCase();
  if (existingByDept.has(key)) continue;
  const id = randomUUID();
  sql += `INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active, created_by, created_at, updated_at) VALUES ('${id}', '${dept.replace(/'/g, "''")}', ${nextDay}, 1, 'system', '${stamp}', '${stamp}');\n`;
  existingByDept.set(dept.toLowerCase(), nextDay);
  nextDay = (nextDay % 5) + 1;
  added++;
}

console.log('executing', added, 'inserts...');
db.exec(sql);
console.log('done');

const check = db.prepare("SELECT department_code, day_of_week FROM mass_department_weekdays WHERE is_active=1 AND department_code IN ('PEACE AND CONFLICT','Office of the Dean - Faculty of Theology','Office of the Deputy Vice-chancellor')").all();
console.log('verified:', check);

db.close();