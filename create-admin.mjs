import Database from "better-sqlite3";
import { hash } from "bcryptjs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const BCRYPT_ROUNDS = 10;
const PASSWORD = "Welcome@123";
const EMAIL = "admin@example.com";
const FULL_NAME = "Administrator";

async function createAdmin() {
  const dbFile = path.resolve(process.cwd(), "db", "attendance.db");
  const db = new Database(dbFile);

  try {
    // Check if admin already exists
    const existingAdmin = db.prepare("SELECT COUNT(*) as count FROM user_roles WHERE role = 'admin'").get();
    if (existingAdmin.count > 0) {
      console.log("Admin already exists. Skipping creation.");
      return;
    }

    const passwordHash = await hash(PASSWORD, BCRYPT_ROUNDS);
    const userId = randomUUID();
    const now = new Date().toISOString().replace("T", " ").slice(0, 19);

    // Use transaction
    const transaction = db.transaction(() => {
      db.prepare("INSERT INTO users (id, email, password_hash, full_name, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(userId, EMAIL.toLowerCase(), passwordHash, FULL_NAME, now);
      db.prepare("INSERT INTO profiles (id, full_name, email, updated_at) VALUES (?, ?, ?, ?)")
        .run(userId, FULL_NAME, EMAIL.toLowerCase(), now);
      db.prepare("INSERT INTO user_roles (id, user_id, role, updated_at) VALUES (?, ?, ?, ?)")
        .run(randomUUID(), userId, "admin", now);
      db.prepare("INSERT INTO audit_logs (id, actor_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)")
        .run(randomUUID(), userId, "account.created", "users", userId);
    });

    transaction();
    console.log(`Created admin account:`);
    console.log(`  Email: ${EMAIL}`);
    console.log(`  Password: ${PASSWORD}`);
  } catch (error) {
    console.error("Error creating admin:", error);
    process.exit(1);
  } finally {
    db.close();
  }
}

createAdmin();