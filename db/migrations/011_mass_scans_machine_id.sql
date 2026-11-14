-- Add machine_id column to mass_scans
-- Note: SQLite doesn't support adding CHECK constraints via ALTER TABLE.
-- The match_method constraint is enforced at the application level.
-- The new 'machine_id' method value is accepted by the application.
ALTER TABLE mass_scans ADD COLUMN machine_id TEXT;

CREATE INDEX mass_scans_machine_id_idx ON mass_scans (machine_id);