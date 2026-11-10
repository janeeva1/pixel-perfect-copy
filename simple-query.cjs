const D = require('better-sqlite3');
const db = new D('db/seed/attendance.db');
const r = db.prepare("SELECT DISTINCT COALESCE(NULLIF(TRIM(department), ''), NULLIF(TRIM(admin_department), '')) AS department FROM staff WHERE COALESCE(NULLIF(TRIM(department), ''), NULLIF(TRIM(admin_department), '')) IS NOT NULL ORDER BY department").all();
console.log('count:', r.length);
console.log(r.slice(0,5));
db.close();