import Database from "better-sqlite3";
import { hash } from "bcryptjs";
import path from "node:path";

const BCRYPT_ROUNDS = 10;
const PASSWORD = "Welcome@123";

async function resetPasswords() {
  const dbFile = path.resolve(process.cwd(), "db", "attendance.db");
  const db = new Database(dbFile);

  try {
    const passwordHash = await hash(PASSWORD, BCRYPT_ROUNDS);
    console.log(`Generated hash for "${PASSWORD}"`);

    const stmt = db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now')");
    const result = stmt.run(passwordHash);

    console.log(`Updated ${result.changes} user(s) with new password hash.`);
  } catch (error) {
    console.error("Error resetting passwords:", error);
    process.exit(1);
  } finally {
    db.close();
  }
}

resetPasswords();