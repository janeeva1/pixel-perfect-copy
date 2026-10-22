-- Weekly Community Mass, version 5.
--
-- The weekday events a recurring template generates answer "was there an event
-- on Tuesday". They cannot answer "who was expected at Week 1's Mass, and who
-- among them did not attend", because expected attendance depends on which
-- weekdays the administrator selected for that week (a public holiday removes
-- a day) and on which weekday each department is assigned to. That question is
-- answered here, with its own tables, and the existing event tables are left
-- exactly as they were.
--
-- Three ideas:
--
--   1. mass_department_weekdays records which weekday each department is
--      expected at. It is configuration, editable from the admin pages, not
--      derived: the registrar's files say nothing about Mass days.
--   2. mass_weeks is one weekly Community Mass record ("Week 1"), with the
--      weekdays selected for it kept beside it in mass_week_weekdays. Sunday
--      Mass is a week with scope 'sunday': no weekdays, expected population is
--      every eligible undergraduate.
--   3. mass_expected freezes who was expected when a scope was processed --
--      person id, number, name, level, department, assigned weekday. A report
--      reads this snapshot, never the live master list, so re-importing the
--      registrar's file or re-assigning a department cannot rewrite what a
--      past week's report said. Uploads and scan rows hang off the week the
--      same way event uploads and scans hang off an event.

-- Department-to-weekday assignment. One row per department, so a department
-- has exactly one expected weekday and cannot be assigned to two days at once.
-- day_of_week follows the JS convention used by recurring_schedules:
-- 1=Monday .. 5=Friday. Saturday and Sunday are not offered: weekday Community
-- Mass runs Monday to Friday, and Sunday Mass is a separate scope on the week.
CREATE TABLE mass_department_weekdays (
  id TEXT NOT NULL PRIMARY KEY,
  department_code TEXT NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX mass_department_weekdays_code_uq ON mass_department_weekdays (department_code);

-- One weekly Community Mass record. scope tells weekday Mass from Sunday Mass:
-- a 'sunday' week carries no weekdays and expects every eligible undergraduate
-- regardless of department assignment. participant_type records what reports
-- this week is for; uploads still name their own participant type so a 'both'
-- week can take a student file and a staff file separately.
CREATE TABLE mass_weeks (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  academic_session TEXT NULL,
  semester TEXT NULL,
  notes TEXT NULL,
  scope TEXT NOT NULL DEFAULT 'weekday' CHECK (scope IN ('weekday', 'sunday')),
  participant_type TEXT NOT NULL DEFAULT 'both'
    CHECK (participant_type IN ('students', 'staff', 'both')),
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'completed', 'archived')),
  created_by TEXT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- The weekdays selected for one week, which are the days the administrator
-- said Community Mass was held. Nothing else feeds the expected calculation:
-- a Monday that was a public holiday is simply absent from this table, and no
-- student is ever expected -- or absent -- because of it.
CREATE TABLE mass_week_weekdays (
  mass_week_id TEXT NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 1 AND 5),
  PRIMARY KEY (mass_week_id, day_of_week),
  FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE
);

-- The expected population for one week and participant type, frozen when the
-- scope was first processed. One row per person; UNIQUE stops a re-build from
-- double-listing anyone. person_no / full_name / level / department are
-- snapshots of what the master list said at that moment, which is what makes a
-- past report reproducible after the master list changes.
CREATE TABLE mass_expected (
  id TEXT NOT NULL PRIMARY KEY,
  mass_week_id TEXT NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('student', 'staff')),
  person_id TEXT NOT NULL,
  person_no TEXT NULL,
  full_name TEXT NULL,
  level TEXT NULL,
  department TEXT NULL,
  day_of_week INTEGER NULL,
  UNIQUE (mass_week_id, participant_type, person_id),
  FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE
);

-- One row per uploaded machine file, remembering which participant type and
-- level it was processed for. Several levels are uploaded separately under the
-- same week and never pooled into one file's counts.
CREATE TABLE mass_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  mass_week_id TEXT NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('student', 'staff')),
  level TEXT NULL,
  file_name TEXT NOT NULL,
  label TEXT NULL,
  row_count INTEGER NOT NULL DEFAULT 0,
  present_count INTEGER NOT NULL DEFAULT 0,
  out_of_scope_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT NULL,
  uploaded_at TEXT NOT NULL,
  FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE
);

-- Every scan row of every upload, classified at the moment it was processed.
-- in_expected is 1 only when the matched person was in the frozen expected
-- population for this upload's scope (participant type and, when the upload
-- named one, level). A matched person outside that scope is in_expected = 0 --
-- the out-of-scope list -- and an unmatched row keeps person_id NULL.
-- Classification is stored rather than re-derived so a later change to the
-- department assignments cannot silently rewrite a week that was processed.
CREATE TABLE mass_scans (
  id TEXT NOT NULL PRIMARY KEY,
  mass_week_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('student', 'staff')),
  scan_number TEXT NULL,
  scanned_name TEXT NULL,
  scanned_at TEXT NOT NULL,
  person_id TEXT NULL,
  match_method TEXT NOT NULL DEFAULT 'none' CHECK (match_method IN ('number', 'name', 'none')),
  in_expected INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE,
  FOREIGN KEY (upload_id) REFERENCES mass_uploads (id) ON DELETE CASCADE
);
CREATE INDEX mass_scans_week_idx ON mass_scans (mass_week_id);
CREATE INDEX mass_scans_week_person_idx ON mass_scans (mass_week_id, participant_type, person_id);
