import Database from "better-sqlite3";
import path from "node:path";

const dbFile = path.resolve(process.cwd(), "db", "attendance.db");
const db = new Database(dbFile);

try {
  const users = db.prepare("SELECT id, email, full_name, password_hash FROM users").all();
  console.log("Users in database:", users.length);
  console.log(users);
} catch (error) {
  console.error("Error:", error);
} finally {
  db.close();
}