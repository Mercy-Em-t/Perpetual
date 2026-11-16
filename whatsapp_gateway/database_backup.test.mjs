import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { executeDatabaseBackup, BACKUP_TABLES } from "./database_backup_sentinel.mjs";

test("Database Backup Sentinel: Dumps all tables, compresses with gzip, and formats notification card", async () => {
  const res = await executeDatabaseBackup();
  assert.equal(res.success, true);
  assert.ok(typeof res.filename === "string");
  assert.ok(res.filename.endsWith(".json.gz"));
  assert.ok(fs.existsSync(res.filePath), "Compressed backup file must exist on disk");
  assert.ok(res.totalRecords > 0, "Should capture database records");
  assert.ok(typeof res.formattedWhatsAppMessage === "string");
  assert.ok(res.formattedWhatsAppMessage.includes("DATABASE BACKUP SENTINEL: 03:00 AM SNAPSHOT"));

  // Verify file has non-zero size
  const stats = fs.statSync(res.filePath);
  assert.ok(stats.size > 1000, "Backup file should be at least 1 KB");

  // Clean up test file
  fs.unlinkSync(res.filePath);
});
