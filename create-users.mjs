import Database from "better-sqlite3";
import { hash } from "bcryptjs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const BCRYPT_ROUNDS = 10;
const PASSWORD = "Welcome@123";
const USERS = [
  { email: "nathan@attendance.com", fullName: "Nathan" },
  { email: "Tapia@attendance.com", fullName: "Tapia" },
  { email: "clinton@attendance.com", fullName: "Clinton" },
];

async function createUsers() {
  const dbFile = path.resolve(process.cwd(), "db", "attendance.db");
  const db = new Database(dbFile);

  try {
    const passwordHash = await hash(PASSWORD, BCRYPT_ROUNDS);
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    for (const user of USERS) {
      const email = user.email.toLowerCase();
      
      // Check if user already exists
      const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
      if (existing) {
        // Update password
        db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE email = ?").run(passwordHash, now, email);
        console.log(`Updated password for: ${email}`);
        continue;
      }

      const userId = randomUUID();

      const transaction = db.transaction(() => {
        db.prepare("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(userId, email, passwordHash, user.fullName, now);
        db.prepare("INSERT INTO profiles (id, full_name, email, updated_at) VALUES (?, ?, ?, ?)")
          .run(userId, user.fullName, email, now);
        db.prepare("INSERT INTO user_roles (id, user_id, role, updated_at) VALUES (?, ?, ?, ?)")
          .run(randomUUID(), userId, "viewer", now);
        db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)")
          .run(randomUUID(), userId, "account.created", "users", userId);
      });

      transaction();
      console.log(`Created user: ${email} (role: viewer)`);
    }

    console.log("\nAll users have password: Welcome@123");
  } catch (error) {
    console.error("Error creating users:", error);
    process.exit(1);
  } finally {
    db.close();
  }
}

createUsers();