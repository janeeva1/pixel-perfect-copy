-- Add machine_id column to mass_scans and update match_method constraint
ALTER TABLE mass_scans ADD COLUMN machine_id TEXT;
ALTER TABLE mass_scans ADD CONSTRAINT mass_scans_match_method_check 
  CHECK (match_method IN ('machine_id', 'number', 'name', 'none'));