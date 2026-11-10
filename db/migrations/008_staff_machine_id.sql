-- Staff machine ID, version 8.
--
-- The registrar's staff file (staffdb.xlsx) carries the number the attendance
-- machine prints for each person in its "Staff_ID_on_machine" column. Until now
-- the app derived that number from the staff number by dropping its letters
-- (staffScanNumberSql()), which worked while the two always agreed but tied
-- matching to a column that can be rekeyed. It is now stored, so the file is the
-- authority and a change of staff number cannot silently change who a scan means.
--
-- The value is not unique: the machine prints the same number for two people in
-- the roster (39 and 65), and a scan is told apart by the name on it, exactly as
-- before. Rows the roster does not cover keep NULL, and matching falls back to
-- the digits of staff_no, so nothing that matched before stops matching.
--
-- SQLite cannot ADD COLUMN IF NOT EXISTS, so this file is applied once, ever.
ALTER TABLE staff ADD COLUMN machine_id TEXT;
CREATE INDEX staff_machine_id_idx ON staff (machine_id);
