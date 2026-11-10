import { syncMassWeekdays } from "./src/server/mass";
import { closeDb, getDb } from "./src/server/db";

process.env["DB_DRIVER"] = "sqlite";
process.env["DB_FILE"] = "./db/seed/attendance.db";

import { syncMassWeekdays } from "./src/server/mass";
import { closeDb, getDb } from "./src/server/db";

async function main() {
  try {
    const result = await syncMassWeekdays("test-user");
    console.log("sync result:", result);
  } catch (e) {
    console.error("Error:", e);
  } finally {
    await closeDb();
  }
}

main();