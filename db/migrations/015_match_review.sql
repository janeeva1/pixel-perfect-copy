-- Matching review, version 15.
--
-- A scan the app cannot match with certainty is no longer guessed. It is kept
-- with needs_review = 1 and the people it could be (review_candidates, a JSON
-- list of person ids), and an administrator picks the right person in the
-- review window before a report is produced. Until then it is counted neither
-- as present nor as unmatched.
ALTER TABLE mass_scans ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE mass_scans ADD COLUMN review_candidates TEXT;
ALTER TABLE staff_scans ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE staff_scans ADD COLUMN review_candidates TEXT;
ALTER TABLE student_scans ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0;
ALTER TABLE student_scans ADD COLUMN review_candidates TEXT;

CREATE INDEX mass_scans_needs_review_idx ON mass_scans (mass_week_id, needs_review);
CREATE INDEX staff_scans_needs_review_idx ON staff_scans (event_id, needs_review);
CREATE INDEX student_scans_needs_review_idx ON student_scans (event_id, needs_review);

-- An administrator's answer for one machine entry (the number and name the
-- machine prints), remembered so the same entry is matched the same way in
-- every later upload without asking again. person_id NULL records "this entry
-- is not anyone on the list".
CREATE TABLE scan_aliases (
  kind TEXT NOT NULL CHECK (kind IN ('student', 'staff')),
  scan_number TEXT NOT NULL DEFAULT '',
  name_key TEXT NOT NULL DEFAULT '',
  person_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, scan_number, name_key)
);

-- Two master records an administrator has confirmed are different people,
-- so the pair is not put to them again. person_a < person_b.
CREATE TABLE distinct_people (
  kind TEXT NOT NULL CHECK (kind IN ('student', 'staff')),
  person_a TEXT NOT NULL,
  person_b TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (kind, person_a, person_b)
);

-- Whether the member of staff is on the registrar's current staff list. An
-- import marked as the complete list (staffdb.xlsx) clears it for anyone not in
-- the file. Such a person is no longer expected at Mass or events, but a scan
-- of theirs still matches them (and shows as out of scope). Importing a file
-- that includes them sets it back.
ALTER TABLE staff ADD COLUMN on_current_list INTEGER NOT NULL DEFAULT 1;
