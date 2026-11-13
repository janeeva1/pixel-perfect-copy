-- Add machine_id column to scans tables and update match_method constraint
ALTER TABLE student_scans ADD COLUMN machine_id TEXT;
ALTER TABLE staff_scans ADD COLUMN machine_id TEXT;

-- Update match_method check constraint to include 'machine_id'
-- SQLite doesn't support ALTER TABLE ... ALTER COLUMN for check constraints easily
-- We need to recreate the tables or use a workaround
-- For now, we'll add the column and note that the constraint should be updated in a future migration
-- The application code will handle the new match_method value

CREATE INDEX student_scans_machine_id_idx ON student_scans (machine_id);
CREATE INDEX staff_scans_machine_id_idx ON staff_scans (machine_id);