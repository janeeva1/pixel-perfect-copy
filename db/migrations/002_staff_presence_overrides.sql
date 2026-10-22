-- Staff presence overrides -----------------------------------------------
--
-- Staff who must be counted present at staff events without having scanned.
--
-- The key is the *derived* scan number, not staff_no and not the digits within
-- it. staff_no is written many ways in the source file for the same person
-- ("1500", "SAT140", "SAT 979"), and the digits are the only part the attendance
-- machine prints, so the digits are the only thing worth matching on. The match
-- is exact, for the same reason scan matching is exact: "140" is a substring of
-- AJ1404, SA1403, SAC 1407, SA 1402, AT1405, SA1409 and AT 1140, and
-- substring matching here would mark all of them present. The derivation is
-- staffScanNumberSql() in src/server/masters.ts, the same expression the scanner
-- uses, so an override is keyed exactly the way a real scan is.
--
-- This is deliberately NOT a column on staff, and it does not create scan rows.
-- Attendance stays computed from scans, as the header of 001 says it must be, so
-- removing an override changes history without touching a single scan. The three
-- built-ins below show up in the admin list only when is_builtin is lifted, and
-- an operator cannot delete them by accident.
--
-- The grant is only ever applied to an event that has at least one staff
-- machine upload (see hasUploadSql() in src/server/presence-overrides.ts), which
-- is what makes "uploading staff machine data triggers it" true. An event with
-- no upload still shows everyone as absent, because nothing has been collected
-- and nothing is being asserted about it.

CREATE TABLE staff_presence_overrides (
  -- The digits of staff_no, as the machine prints them. See the header.
  scan_number TEXT NOT NULL PRIMARY KEY,
  -- Why this person is credited. Recorded rather than implied, so the CSV can
  -- say "present by override" instead of leaving a silent hole in the data.
  reason TEXT NOT NULL,
  -- 1 for the three seeded below. A built-in is listed in the admin UI under
  -- "always present" and cannot be removed; an added one is a normal row.
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
);

-- The three ICT Unit staff who are expected at every staff event whether or not
-- the machine saw them. reason is written as the reason an auditor would want
-- to read, not as a code.
--
-- IGNORE, not a plain INSERT: a database that was reset from schema.sql and then
-- migrated would otherwise fail the whole file on the duplicate key.
INSERT OR IGNORE INTO staff_presence_overrides (scan_number, reason, is_builtin) VALUES
  ('1500', 'Credited present at every staff event without a scan (ICT Unit).', 1),
  ('140',  'Credited present at every staff event without a scan (ICT Unit).', 1),
  ('979',  'Credited present at every staff event without a scan (ICT Unit).', 1);
