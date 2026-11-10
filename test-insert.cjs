const D = require('better-sqlite3');
const { randomUUID } = require('crypto');
const db = new D('db/seed/attendance.db');

const stamp = new Date().toISOString().slice(0, 19).replace('T', ' ');
const stmt = db.prepare("INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, 'system', ?, ?)");

const id = randomUUID();
console.log('running insert...');
stmt.run(id, 'TEST DEPT', 1, stamp, stamp);
console.log('insert done');

const check = db.prepare("SELECT * FROM mass_department_weekdays WHERE department_code = 'TEST DEPT'").get();
console.log('check:', check);

db.close();