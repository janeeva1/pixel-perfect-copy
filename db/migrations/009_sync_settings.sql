-- Sync settings, version 9.
--
-- Stores the hub (MariaDB) connection details so the operator can configure
-- synchronization entirely from the UI. The password is stored encrypted with
-- a per-installation key so it is not readable if the database file is copied.
--
-- Only one row ever exists (id = 1). The application upserts into this row.
--
-- SQLite cannot ADD COLUMN IF NOT EXISTS, so this file is applied once, ever.
CREATE TABLE sync_settings (
  id INTEGER NOT NULL PRIMARY KEY CHECK (id = 1),
  host TEXT NOT NULL DEFAULT '',
  port INTEGER NOT NULL DEFAULT 3306,
  user TEXT NOT NULL DEFAULT '',
  -- Password encrypted with a per-installation key (see src/server/sync.ts).
  -- Empty string means "not set".
  password_enc TEXT NOT NULL DEFAULT '',
  database TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed a default row so the table is never empty.
INSERT INTO sync_settings (id, host, port, user, password_enc, database, updated_at)
VALUES (1, '', 3306, '', '', '', datetime('now'));