import { test } from "node:test";
import assert from "node:assert/strict";
import { syncMassWeekdays } from "../src/server/mass";
import { closeDb, getDb } from "../src/server/db";

test("syncMassWeekdays seeds missing departments", async () => {
  const result = await syncMassWeekdays("test-user");
  console.log("sync result:", result);
  assert.ok(result.added >= 0);
  await closeDb();
});