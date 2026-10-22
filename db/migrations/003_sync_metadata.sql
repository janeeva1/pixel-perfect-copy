-- Sync metadata and edit stamps, version 3.
--
-- The desktop app keeps its own SQLite file and an office syncs it against the
-- shared MariaDB hub by hand (see src/server/sync.ts). Two things that feature
-- needs are missing from 001 and 002:
--
--   1. An `updated_at` on the tables the operators edit. Sync decides "most
--      recent edit wins" from these columns, so a row without one is a row the
--      machine cannot arbitrate. SQLite cannot ADD COLUMN IF NOT EXISTS (that
--      is why these files are numbered), so each one is plain ALTER ADD COLUMN
--      and the migration file is applied once, ever.
--   2. A place to remember this device's identity and the last thing it heard
--      from the hub. sync_meta holds one row per key; sync_log records each run
--      for the admin page. Neither is a copy of any synced table — they are
--      about the sync itself.

-- Note on the default: SQLite refuses `DEFAULT CURRENT_TIMESTAMP` on an
-- ALTER ... ADD COLUMN because the default is not a constant. A literal epoch
-- is used instead, and existing rows are then stamped from their own
-- created_at (the .000 makes every stamp the same 'YYYY-MM-DD HH:MM:SS.mmm'
-- shape sync compares). New rows are always written by the app itself
-- (utcStamp() in src/server/db.ts), so this default is only a placeholder.
ALTER TABLE students ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';
ALTER TABLE staff ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';
ALTER TABLE student_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';
ALTER TABLE staff_events ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';
ALTER TABLE staff_presence_overrides ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';
ALTER TABLE profiles ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';
ALTER TABLE user_roles ADD COLUMN updated_at TEXT NOT NULL DEFAULT '1970-01-01 00:00:00.000';

UPDATE students SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';
UPDATE staff SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';
UPDATE student_events SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';
UPDATE staff_events SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';
UPDATE staff_presence_overrides SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';
UPDATE profiles SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';
UPDATE user_roles SET updated_at = created_at || '.000' WHERE updated_at = '1970-01-01 00:00:00.000';

-- One row per key. Copies of this table's values are used as sync_meta on each
-- device, so no machine is ever the authoritative holder of another's identity.
CREATE TABLE sync_meta (
  key TEXT NOT NULL PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every successful run, so the Synchronize page can show what the last one did.
CREATE TABLE sync_log (
  id TEXT NOT NULL PRIMARY KEY,
  synced_at TEXT NOT NULL,
  device_id TEXT NOT NULL,
  pushed INTEGER NOT NULL DEFAULT 0,
  pulled INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);
CREATE INDEX sync_log_synced_idx ON sync_log (synced_at);