-- Attendance Register — local MySQL/MariaDB schema.
-- Applied by `npm run db:migrate` (db/migrate.mjs). Every statement is
-- CREATE ... IF NOT EXISTS, so re-running is safe.
--
-- Design notes:
--   * The two master tables hold the columns that are in the registrar's
--     files. There is no extra column for whatever number the attendance
--     machine prints, because in both files that number is already derivable
--     from a column that is stored: for a student it is the tail of the matric
--     number, for staff the digits of the staff number. The derivations are in
--     src/server/masters.ts (studentScanNumberSql, staffScanNumberSql).
--     Level comes from the file. The undergraduate/postgraduate category is
--     read out of the matric number whenever it is needed, so it is not stored:
--       VUG/2021/2633     -> undergraduate
--       VPG/PGD/2020/1042 -> postgraduate
--     See CATEGORY_SQL in src/server/masters.ts. The department's full name as
--     the file spells it ("Computer and Information Technology") and the
--     student's marital status are stored verbatim: they are the file's own
--     text, kept for display, for scoping and for the Sunday Mass rule.
--   * Attendance is never stored on a person. Present, absent, out of scope and
--     unmatched are recalculated from the master list every time a report runs,
--     so a corrected import fixes history without touching the scans.
--   * The only writes to a master table are an admin upload, and a re-upload
--     updates the same person because matric_no and staff_no are unique.
--   * Events, uploads and scans are duplicated per group on purpose, so a
--     student report never has to branch on a "person type" column.
--   * Postgres ENUM became inline ENUM; uuid + timestamptz became CHAR(36) +
--     DATETIME(3). The pool runs in UTC.

-- Accounts ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id CHAR(36) NOT NULL,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS profiles (
  id CHAR(36) NOT NULL,
  full_name VARCHAR(120) NULL,
  email VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY user_roles_user_role_unique (user_id, role),
  KEY user_roles_role_idx (role),
  CONSTRAINT user_roles_user_fkey FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id CHAR(36) NOT NULL,
  actor_id CHAR(36) NULL,
  action VARCHAR(64) NOT NULL,
  entity VARCHAR(64) NULL,
  entity_id CHAR(36) NULL,
  details JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY audit_logs_created_idx (created_at),
  KEY audit_logs_actor_idx (actor_id),
  CONSTRAINT audit_logs_actor_fkey FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Master data ------------------------------------------------------------
--
-- student_db.csv  id, lname, fname, mname, matric_no, level
-- staff_db.csv    id, lname, fname, mname, staff_no
--
-- These tables mirror the file and nothing else. There is no extra column for
-- whatever number the machine prints, because in both files that number is
-- already derivable from a column that is stored:
--
--   student  the machine prints the last part of the matric number,
--            VUG/ACC/25/13514 -> 13514, and all 8,760 of those are distinct
--   staff    the machine prints the digits of the staff number,
--            "SA 1188" -> 1188
--
-- The derivations live in src/server/masters.ts and are applied when a scan is
-- matched, so no number is stored twice and no number can drift from the field
-- it came from. The id column of the source file is the id column of the
-- machine's own numbering and is not kept: for students it repeats the matric
-- number, and for staff the machine uses the staff number instead.
--
-- Nothing derived is stored. The undergraduate/postgraduate category is worked
-- out from matric_no in SQL (see src/server/masters.ts). The department's full
-- name and the marital status are stored because the registrar's file holds
-- them, not because anything derived them.

CREATE TABLE IF NOT EXISTS students (
  id CHAR(36) NOT NULL,
  matric_no VARCHAR(64) NOT NULL,
  last_name VARCHAR(80) NULL,
  first_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  level VARCHAR(64) NULL,
  -- The department's full name as the file spells it. This is the department
  -- every scope, filter and Mass assignment uses; it is kept verbatim.
  department VARCHAR(120) NULL,
  -- From the same file, when the file has one. 'Religious' students are left
  -- out of Sunday Mass expected populations (src/server/mass.ts); nothing
  -- else reads it.
  marital_status VARCHAR(32) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY students_matric_unique (matric_no),
  KEY students_level_idx (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- staff_no is the natural key, since it is the one identifier the staff file
-- always supplies and it is distinct on all 1,112 rows that have one. Two rows
-- carry the literal text NULL, which is read as "no staff number" and stored as
-- NULL; NULLs do not collide in a unique key, so both are kept.
CREATE TABLE IF NOT EXISTS staff (
  id CHAR(36) NOT NULL,
  staff_no VARCHAR(64) NULL,
  last_name VARCHAR(80) NULL,
  first_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  faculty VARCHAR(120) NULL,
  department VARCHAR(120) NULL,
  admin_department VARCHAR(120) NULL,
  -- The number the attendance machine prints for this person, from the
  -- registrar's staff file. Not unique: the machine prints the same number for
  -- two people, and the name on the scan separates them (see
  -- src/server/masters.ts, staffScanNumberSql()).
  machine_id VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY staff_no_unique (staff_no),
  KEY staff_machine_id_idx (machine_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Student events ---------------------------------------------------------
--
-- An event is one attendance exercise on one date, narrowed to a scope: a
-- category (undergraduate/postgraduate), a level, a department, or any
-- combination. "Expected" is everyone matching the scope, recalculated live from
-- the master list, so it is never stored here. start_time/end_time are advisory:
-- they are shown on reports and used to flag scans that fall outside the event
-- window, but an upload always counts.

CREATE TABLE IF NOT EXISTS student_events (
  id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  event_date DATE NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  student_category ENUM('undergraduate', 'postgraduate') NULL,
  level VARCHAR(64) NULL,
  department_code VARCHAR(120) NULL,
  notes TEXT NULL,
  status ENUM('draft', 'finalized') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) NULL,
  finalized_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY student_events_date_idx (event_date),
  KEY student_events_status_idx (status),
  CONSTRAINT student_events_creator_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per uploaded machine file. An event can have many: clock-in, then
-- clock-out, then a re-export.
CREATE TABLE IF NOT EXISTS student_event_uploads (
  id CHAR(36) NOT NULL,
  event_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  label VARCHAR(80) NULL,
  row_count INT NOT NULL DEFAULT 0,
  present_count INT NOT NULL DEFAULT 0,
  out_of_scope_count INT NOT NULL DEFAULT 0,
  unmatched_count INT NOT NULL DEFAULT 0,
  uploaded_by CHAR(36) NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY student_uploads_event_idx (event_id),
  CONSTRAINT student_uploads_event_fkey FOREIGN KEY (event_id) REFERENCES student_events (id) ON DELETE CASCADE,
  CONSTRAINT student_uploads_user_fkey FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every scan row is kept, so clock-in and clock-out can both be shown and
-- repeat scans are visible instead of being collapsed away. student_id is null
-- when the number on the scan could not be resolved to a student in this
-- event's scope; scanned_name and scan_number are kept so the row can be
-- looked up by hand. This is the only table that holds a number the machine
-- printed: it is the scan's own value, not a copy of anything in the master.
CREATE TABLE IF NOT EXISTS student_scans (
  id CHAR(36) NOT NULL,
  event_id CHAR(36) NOT NULL,
  upload_id CHAR(36) NOT NULL,
  scan_number VARCHAR(64) NULL,
  scanned_name VARCHAR(160) NULL,
  scanned_at DATETIME(3) NOT NULL,
  student_id CHAR(36) NULL,
  match_method ENUM('number', 'name', 'none') NOT NULL DEFAULT 'none',
  in_scope TINYINT(1) NOT NULL DEFAULT 0,
  outside_window TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY student_scans_event_idx (event_id),
  KEY student_scans_event_student_idx (event_id, student_id),
  KEY student_scans_time_idx (scanned_at),
  CONSTRAINT student_scans_event_fkey FOREIGN KEY (event_id) REFERENCES student_events (id) ON DELETE CASCADE,
  CONSTRAINT student_scans_upload_fkey FOREIGN KEY (upload_id) REFERENCES student_event_uploads (id) ON DELETE CASCADE,
  CONSTRAINT student_scans_student_fkey FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Staff events -----------------------------------------------------------
--
-- A staff event has no category and no level, but it can be scoped to departments:
-- the staff file carries a department for 802 of its 806 rows, so a department is
-- a real grouping here. It is free text and spelled differently per row, so it is
-- not normalised into a table; the department a person belongs to is worked out
-- with staffDepartmentSql(), preferring the department they administer and
-- falling back to the one listed beside them. The four staff with neither cannot
-- be placed, so they are outside a department-scoped event and expected at one
-- that names no department.

CREATE TABLE IF NOT EXISTS staff_events (
  id CHAR(36) NOT NULL,
  title VARCHAR(160) NOT NULL,
  event_date DATE NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  notes TEXT NULL,
  status ENUM('draft', 'finalized') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) NULL,
  finalized_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY staff_events_date_idx (event_date),
  KEY staff_events_status_idx (status),
  CONSTRAINT staff_events_creator_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_event_uploads (
  id CHAR(36) NOT NULL,
  event_id CHAR(36) NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  label VARCHAR(80) NULL,
  row_count INT NOT NULL DEFAULT 0,
  present_count INT NOT NULL DEFAULT 0,
  out_of_scope_count INT NOT NULL DEFAULT 0,
  unmatched_count INT NOT NULL DEFAULT 0,
  uploaded_by CHAR(36) NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY staff_uploads_event_idx (event_id),
  CONSTRAINT staff_uploads_event_fkey FOREIGN KEY (event_id) REFERENCES staff_events (id) ON DELETE CASCADE,
  CONSTRAINT staff_uploads_user_fkey FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_scans (
  id CHAR(36) NOT NULL,
  event_id CHAR(36) NOT NULL,
  upload_id CHAR(36) NOT NULL,
  scan_number VARCHAR(64) NULL,
  scanned_name VARCHAR(160) NULL,
  scanned_at DATETIME(3) NOT NULL,
  staff_id CHAR(36) NULL,
  match_method ENUM('number', 'name', 'none') NOT NULL DEFAULT 'none',
  in_scope TINYINT(1) NOT NULL DEFAULT 0,
  outside_window TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY staff_scans_event_idx (event_id),
  KEY staff_scans_event_staff_idx (event_id, staff_id),
  KEY staff_scans_time_idx (scanned_at),
  CONSTRAINT staff_scans_event_fkey FOREIGN KEY (event_id) REFERENCES staff_events (id) ON DELETE CASCADE,
  CONSTRAINT staff_scans_upload_fkey FOREIGN KEY (upload_id) REFERENCES staff_event_uploads (id) ON DELETE CASCADE,
  CONSTRAINT staff_scans_staff_fkey FOREIGN KEY (staff_id) REFERENCES staff (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Recurring event templates ------------------------------------------------
-- A template defines a repeating weekly pattern (e.g., Community Mass).
-- It generates concrete events for a semester date range. group_kind says which
-- master list the generated events are drawn from, because a student event and a
-- staff event are different tables with different scopes.

CREATE TABLE IF NOT EXISTS recurring_templates (
  id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  description TEXT NULL,
  group_kind ENUM('student', 'staff') NOT NULL DEFAULT 'student',
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  event_title_template VARCHAR(160) NOT NULL,
  start_time TIME NULL,
  end_time TIME NULL,
  notes TEXT NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY recurring_templates_date_idx (start_date, end_date),
  CONSTRAINT recurring_templates_creator_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- An install that already has this table predates group_kind, and CREATE TABLE
-- IF NOT EXISTS above is skipped for it. Every existing template generated
-- student events, so 'student' is the correct default rather than a guess.
ALTER TABLE recurring_templates
  ADD COLUMN IF NOT EXISTS group_kind ENUM('student', 'staff') NOT NULL DEFAULT 'student';

-- Weekly schedule entries for a template.
-- day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday
-- scope is expressed as category/level/departments (same as the events)
--
-- A day can cover several departments, so the departments live in their own
-- table rather than in one department_code column. They are free text on the
-- staff side ("Medical Sciences"), so a delimiter would be a latent bug the
-- first department with a comma in its name would trigger.
--
-- department_code is the old single-department column. It is kept only so an
-- install that already has it can be carried across into the junction table
-- below; nothing writes it any more. It is left in place rather than dropped so
-- that one schema file works for a fresh database and an existing one, since a
-- backfill cannot refer to a column that a fresh database never had.

CREATE TABLE IF NOT EXISTS recurring_schedules (
  id CHAR(36) NOT NULL,
  template_id CHAR(36) NOT NULL,
  -- 0=Sunday to 6=Saturday. The column is UNSIGNED, so this is the only thing
  -- stopping a 7, which SQLite already refuses and this engine used to accept.
  day_of_week TINYINT UNSIGNED NOT NULL,
  student_category ENUM('undergraduate', 'postgraduate') NULL,
  level VARCHAR(64) NULL,
  title_suffix VARCHAR(80) NULL,
  department_code VARCHAR(120) NULL,
  PRIMARY KEY (id),
  KEY recurring_schedules_template_idx (template_id),
  CONSTRAINT recurring_schedules_template_fkey FOREIGN KEY (template_id) REFERENCES recurring_templates (id) ON DELETE CASCADE,
  CONSTRAINT recurring_schedules_day_of_week_chk CHECK (day_of_week BETWEEN 0 AND 6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Departments expected on one scheduled day. A department name on a student or
-- staff template. Empty means everyone.
CREATE TABLE IF NOT EXISTS recurring_schedule_departments (
  schedule_id CHAR(36) NOT NULL,
  department VARCHAR(120) NOT NULL,
  PRIMARY KEY (schedule_id, department),
  KEY recurring_schedule_departments_dept_idx (department),
  CONSTRAINT recurring_schedule_departments_schedule_fkey FOREIGN KEY (schedule_id) REFERENCES recurring_schedules (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Carry an existing install's single department across, so a template that
-- already names a department does not silently widen to everyone when the
-- junction table starts being used. On a fresh database there is nothing to
-- copy and this inserts no rows.
INSERT IGNORE INTO recurring_schedule_departments (schedule_id, department)
  SELECT id, TRIM(department_code) FROM recurring_schedules
  WHERE department_code IS NOT NULL AND TRIM(department_code) <> '';

-- Link generated events back to their template/schedule
ALTER TABLE student_events ADD COLUMN IF NOT EXISTS template_id CHAR(36) NULL;
ALTER TABLE student_events ADD COLUMN IF NOT EXISTS schedule_id CHAR(36) NULL;
CREATE INDEX IF NOT EXISTS student_events_template_idx ON student_events (template_id);
CREATE INDEX IF NOT EXISTS student_events_schedule_idx ON student_events (schedule_id);
ALTER TABLE staff_events ADD COLUMN IF NOT EXISTS template_id CHAR(36) NULL;
ALTER TABLE staff_events ADD COLUMN IF NOT EXISTS schedule_id CHAR(36) NULL;
CREATE INDEX IF NOT EXISTS staff_events_template_idx ON staff_events (template_id);
CREATE INDEX IF NOT EXISTS staff_events_schedule_idx ON staff_events (schedule_id);

-- Multi-department scope for events. An event with no row here is unscoped and
-- expects everyone, which is how every event behaved before this existed.
-- student_events.department_code stays as the single-department shorthand and is
-- kept in step for the first department, so older readers and the CSV label
-- still show something sensible.
CREATE TABLE IF NOT EXISTS student_event_departments (
  event_id CHAR(36) NOT NULL,
  department_code VARCHAR(120) NOT NULL,
  PRIMARY KEY (event_id, department_code),
  KEY student_event_departments_dept_idx (department_code),
  CONSTRAINT student_event_departments_event_fkey FOREIGN KEY (event_id) REFERENCES student_events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS staff_event_departments (
  event_id CHAR(36) NOT NULL,
  department VARCHAR(120) NOT NULL,
  PRIMARY KEY (event_id, department),
  KEY staff_event_departments_dept_idx (department),
  CONSTRAINT staff_event_departments_event_fkey FOREIGN KEY (event_id) REFERENCES staff_events (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the new table from the single-department column so no student event that
-- already exists silently loses its scope. Staff events never had a scope to
-- carry over, so there is nothing to seed for them.
INSERT IGNORE INTO student_event_departments (event_id, department_code)
  SELECT id, TRIM(department_code) FROM student_events
  WHERE department_code IS NOT NULL AND TRIM(department_code) <> '';

-- Event category: a Community Mass, or anything else. The reports and the
-- dashboard are broken down by this, so it is stored rather than guessed from
-- the title: renaming an event must never move it between categories, and a
-- Mass event whose title happens not to say "Mass" must still be found.
-- 'other' is the default so every event that already exists is counted
-- somewhere, and nothing is silently dropped from a report.
ALTER TABLE student_events
  ADD COLUMN IF NOT EXISTS event_category ENUM('community_mass', 'other') NOT NULL DEFAULT 'other';
ALTER TABLE staff_events
  ADD COLUMN IF NOT EXISTS event_category ENUM('community_mass', 'other') NOT NULL DEFAULT 'other';
ALTER TABLE recurring_templates
  ADD COLUMN IF NOT EXISTS event_category ENUM('community_mass', 'other') NOT NULL DEFAULT 'other';
CREATE INDEX IF NOT EXISTS student_events_category_idx ON student_events (event_category, event_date);
CREATE INDEX IF NOT EXISTS staff_events_category_idx ON staff_events (event_category, event_date);

-- No data is changed here. An earlier version of this file guessed a category
-- from the event's title, so that the Community Mass breakdown was not empty on
-- the day the column was added. That guess was removed for two reasons:
--
--   'other' is both the default and a legitimate choice, so a `WHERE
--   event_category = 'other'` guard cannot tell "never categorised" from "set
--   back to other on purpose", and re-running the migration kept overriding the
--   second one. Every migrate undid the admin's correction.
--
--   And LOWER(title) LIKE '%mass%' is not a category. It matches 'MASSAGE' and
--   'Molecular Mass', and misses a Community Mass whose title says 'Holy Mass'.
--
-- Existing events therefore stay 'other' and are counted under Other, which is
-- reported rather than dropped. To categorise the ones already loaded, review
-- them and set the category on each event, or run the one-off helper, which
-- previews before it writes:
--
--   npm run db:backfill-categories          list what it would change
--   npm run db:backfill-categories -- --apply   write it

-- Weekly Community Mass ---------------------------------------------------
--
-- The weekday events above answer "was there an event on Tuesday". They cannot
-- answer "who was expected at Week 1's Mass, and who among them did not
-- attend": that depends on which weekdays the administrator selected for the
-- week (a public holiday removes a day) and on which weekday each department
-- is assigned to. These tables answer it, and the event tables are untouched.
-- SQLite builds these in db/migrations/005_weekly_mass.sql; the shapes match.

-- One row per department, so a department has exactly one expected weekday.
-- day_of_week: 1=Monday .. 5=Friday (the JS convention, as in
-- recurring_schedules). Saturday and Sunday are not offered: weekday Mass runs
-- Monday to Friday, and Sunday Mass is a separate scope on the week.
CREATE TABLE IF NOT EXISTS mass_department_weekdays (
  id CHAR(36) NOT NULL,
  department_code VARCHAR(120) NOT NULL,
  day_of_week TINYINT UNSIGNED NOT NULL,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY mass_department_weekdays_code_uq (department_code),
  CONSTRAINT mass_department_weekdays_day_chk CHECK (day_of_week BETWEEN 1 AND 5),
  CONSTRAINT mass_department_weekdays_user_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Seed the weekday department assignments (see db/migrations/007_seed_mass_weekdays.sql
-- for the SQLite twin). mass_department_weekdays is configuration, editable from the
-- admin pages; the registrar's files say nothing about Mass days, so the initial
-- set is seeded from the roster mapped against assigned.txt. Each statement is
-- guarded on the unique department_code, so re-applying schema.sql cannot duplicate
-- a row or overwrite a weekday an administrator has since changed. A department
-- that is not listed is simply never expected, so a new department added by input
-- or upload cannot break anything.
INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '6e5a0a41-f47c-24f2-f985-3d5d36c7d867', 'Academic Planning', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Academic Planning');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '4db218fa-9684-bd45-713e-aa606e38cca3', 'Accounting', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Accounting');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '392e9d2a-bd85-7ee8-a299-de24b98a693f', 'Arts and Social Science Education', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Arts and Social Science Education');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'b50fcae1-f2be-1c4b-cd29-f2f253fbf7d7', 'Banking and Finance', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Banking and Finance');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '85576d71-6d63-90a8-f865-bc54fa2b979e', 'Biochemistry', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Biochemistry');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '249f778b-c27b-6e33-4501-a7a57b05d5a5', 'Biotechnology/Environmental Biology', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Biotechnology/Environmental Biology');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'e3828aaa-ed31-2693-92f4-9d8a0895b60d', 'Bursary', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Bursary');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '3c4d4d83-50f8-1c11-2123-bb2eed3dfad3', 'Business Administration', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Business Administration');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '96bbb4ee-9e8a-94f1-8049-027130967c06', 'Chaplaincy', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Chaplaincy');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'b86b2177-9976-3a57-65a5-ae7ae0bcef97', 'Computer Engineering', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Computer Engineering');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '25fb90e8-ce1d-9e2b-edfd-3fa273f9849f', 'Computer Science', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Computer Science');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'baccd83f-fcc1-2316-edeb-79155d98fd31', 'Consultancy', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Consultancy');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '5fc2fdcc-061d-ef5c-9374-f85cfba9adc9', 'Counselling', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Counselling');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '7cdaf80e-04f2-3ab0-53c1-7659c81b372a', 'Debt Recovery Office', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Debt Recovery Office');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'b8f3b908-5201-cbba-ea00-e299f2954d65', 'Directorate of Research and International Linkages', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Directorate of Research and International Linkages');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '561c9a5a-ca67-2122-e1f6-14d6954c797a', 'Economics', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Economics');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'e38aaf28-6657-b2f0-ab69-69d188f4d1ea', 'Educational Foundation', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Educational Foundation');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '7f01a1af-1cdf-fd00-6d82-ef5fa1a2d9e6', 'Electrical and Electronic Engineering', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Electrical and Electronic Engineering');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '67c3e808-af91-3088-6d24-2386bfbe3179', 'Engineering', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Engineering');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '3304aaa4-dec8-eb34-86fa-812ae00b87c4', 'English and Literary Studies', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'English and Literary Studies');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '1679b809-0177-6360-36df-8a0ff365afa1', 'Entrepreneurship', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Entrepreneurship');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '6d96f4c5-5d84-ac5a-60b9-03dcb593897c', 'GUIDANCE AND COUNSELLING', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'GUIDANCE AND COUNSELLING');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'e96b3a97-ba73-8bf0-cb29-4820db7d7b87', 'General Studies', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'General Studies');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'ee827e16-5e77-586f-e008-779f641e816e', 'Health Sciences', 3, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Health Sciences');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '70efbeb7-da1a-e7ba-9e4f-23cd73026a5c', 'History and International Relations', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'History and International Relations');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '86cdc180-f549-c2de-956d-baa1c9a2cd09', 'ICT', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'ICT');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'ee3ce683-b4ac-1a1c-a014-33006e74ee94', 'Internal Audit', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Internal Audit');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '766fd528-e97d-6f64-ef29-a553b99b17a0', 'Law', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Law');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '6d718eb8-476e-f207-1291-cb32d44f3a15', 'Library', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Library');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '8973cbe7-74df-a696-4e1c-6e581579647f', 'MATHEMATICAL SCIENCES', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'MATHEMATICAL SCIENCES');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '5e1bc854-dc77-9c75-0229-865343f2ed02', 'Marketing', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Marketing');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '083b9d3b-1638-6f81-f726-4b4f0c526511', 'Mass Communication', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Mass Communication');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '85fd0772-be73-6074-a3ba-d4541adadcb5', 'Medical Centre', 3, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Medical Centre');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '395f1b2c-496b-ded2-9a33-d45fc360dc5a', 'Medical Laboratory Science', 3, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Medical Laboratory Science');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '7e15aa0e-54a6-5278-c0a9-daa1e7fee721', 'Medicine', 3, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Medicine');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '85772d3f-c6b8-7428-0908-eafd45628789', 'Microbiology', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Microbiology');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'e31202cf-5c49-e3d2-3fae-a30f8e7acbc5', 'Nursing', 3, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Nursing');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '668ecb25-db18-de19-39d5-c8d4dbafd8b6', 'Office of the Dean - Education', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Office of the Dean - Education');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'a9cf4f39-e8bd-f7e4-d21d-e6b9a7e6009d', 'Office of the Dean - Faculty of Engineering', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Office of the Dean - Faculty of Engineering');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '4eef10f3-bb97-2015-f713-51e243f9b573', 'Office of the Dean - Faculty of Natural and Applied Sciences', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Office of the Dean - Faculty of Natural and Applied Sciences');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '40a0c493-da9c-7090-0101-adf3130a8363', 'Office of the Dean - Humanities', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Office of the Dean - Humanities');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'cc647384-f27e-6c43-9ded-a254cc6724be', 'Office of the Dean - Management Sciences', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Office of the Dean - Management Sciences');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '4f2ca90a-e830-a9dd-e2f3-594cb2ab1e6f', 'Office of the Dean - Social Sciences', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Office of the Dean - Social Sciences');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'b828519a-7878-97bb-aae6-4bf6648075a0', 'Pharmaceutical Science', 3, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Pharmaceutical Science');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '5a537d0c-05aa-c3f3-18ca-bfde1d9e5a1c', 'Performing Arts', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Performing Arts');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '661b21a8-7769-8398-d2bb-8663792d40bb', 'Philosophy', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Philosophy');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'e6eea160-ac08-8938-d0e9-db54832ae17a', 'Political Science and Diplomacy', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Political Science and Diplomacy');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '0d9ac744-f1cf-a3b7-eca3-eb99e8a68e77', 'Postgraduate School', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Postgraduate School');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '654545db-daa7-ba00-c039-6e528c34e24c', 'Public Administration', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Public Administration');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'dbf84d6e-e8a5-12d6-2f59-f5e708ef281a', 'Pure and Applied Chemistry', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Pure and Applied Chemistry');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'ff8c7ae4-02d5-b8c9-54d1-865cabbb6491', 'Pure and Applied Physics/Mathematics', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Pure and Applied Physics/Mathematics');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '29b9940a-6a73-1c82-cb0f-78ea3db47158', 'Registry', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Registry');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '03f0b727-434b-6edf-aae3-ea0be6ee7510', 'Religious Studies', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Religious Studies');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'bcfd741e-e741-adcd-e8ed-5d154719d991', 'SIWES Unit', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'SIWES Unit');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '42e2f0ee-7386-5473-6c48-112a3993b41e', 'Sandwich Programme', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Sandwich Programme');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'b420404c-3517-686b-c5d2-d6c69daf9be6', 'Science Education', 4, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Science Education');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '4f800912-53c2-a582-1bd3-11b024573af3', 'Security', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Security');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '51ace3cb-a32e-a8c2-d640-f64e2b2174dd', 'Software Engineering', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Software Engineering');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'a3e69e8c-6c4a-3b8d-664a-0c14730bd9c0', 'Student Affairs', 5, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Student Affairs');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '78b34d2d-68c8-cf9f-0b5c-6b4a8b7bd18c', 'Theology', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Theology');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'de39011b-e693-ef77-78a2-1f686f605550', 'Transport', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Transport');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT 'c609c8db-484a-642d-ad57-419a1e500050', 'VCs Office', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'VCs Office');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '0aa98bd8-6273-1c2a-85b1-b43298a830d2', 'Water Factory', 2, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Water Factory');

INSERT INTO mass_department_weekdays (id, department_code, day_of_week, is_active)
SELECT '20a338ad-0422-088c-4b62-83314015294a', 'Works and Estate', 1, 1 FROM DUAL
WHERE NOT EXISTS (SELECT 1 FROM mass_department_weekdays WHERE department_code = 'Works and Estate');

-- One weekly Community Mass record. scope separates weekday Mass from Sunday
-- Mass: a 'sunday' week carries no weekdays and expects every eligible
-- undergraduate regardless of department assignment.
CREATE TABLE IF NOT EXISTS mass_weeks (
  id CHAR(36) NOT NULL,
  name VARCHAR(160) NOT NULL,
  academic_session VARCHAR(64) NULL,
  semester VARCHAR(32) NULL,
  notes TEXT NULL,
  scope ENUM('weekday', 'sunday') NOT NULL DEFAULT 'weekday',
  participant_type ENUM('students', 'staff', 'both') NOT NULL DEFAULT 'both',
  status ENUM('draft', 'active', 'completed', 'archived') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY mass_weeks_status_idx (status),
  CONSTRAINT mass_weeks_creator_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The weekdays selected for one week -- the days Community Mass was held. A
-- Monday that was a public holiday is simply absent from this table, and no
-- student is ever expected, or absent, because of it.
CREATE TABLE IF NOT EXISTS mass_week_weekdays (
  mass_week_id CHAR(36) NOT NULL,
  day_of_week TINYINT UNSIGNED NOT NULL,
  PRIMARY KEY (mass_week_id, day_of_week),
  CONSTRAINT mass_week_weekdays_week_fkey FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE,
  CONSTRAINT mass_week_weekdays_day_chk CHECK (day_of_week BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The expected population for one week and participant type, frozen when the
-- scope was first processed. The name/level/department columns are snapshots
-- of what the master list said at that moment, which is what lets a past
-- report be reproduced after the master list changes.
CREATE TABLE IF NOT EXISTS mass_expected (
  id CHAR(36) NOT NULL,
  mass_week_id CHAR(36) NOT NULL,
  participant_type ENUM('student', 'staff') NOT NULL,
  person_id CHAR(36) NOT NULL,
  person_no VARCHAR(64) NULL,
  full_name VARCHAR(240) NULL,
  level VARCHAR(64) NULL,
  department VARCHAR(120) NULL,
  day_of_week TINYINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY mass_expected_person_uq (mass_week_id, participant_type, person_id),
  KEY mass_expected_week_idx (mass_week_id),
  CONSTRAINT mass_expected_week_fkey FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- One row per uploaded machine file, remembering which participant type and
-- level it was processed for. Levels are uploaded separately under the same
-- week and never pooled into one file's counts.
CREATE TABLE IF NOT EXISTS mass_uploads (
  id CHAR(36) NOT NULL,
  mass_week_id CHAR(36) NOT NULL,
  participant_type ENUM('student', 'staff') NOT NULL,
  level VARCHAR(64) NULL,
  file_name VARCHAR(255) NOT NULL,
  label VARCHAR(80) NULL,
  row_count INT NOT NULL DEFAULT 0,
  present_count INT NOT NULL DEFAULT 0,
  out_of_scope_count INT NOT NULL DEFAULT 0,
  unmatched_count INT NOT NULL DEFAULT 0,
  uploaded_by CHAR(36) NULL,
  uploaded_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY mass_uploads_week_idx (mass_week_id),
  CONSTRAINT mass_uploads_week_fkey FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE,
  CONSTRAINT mass_uploads_user_fkey FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every scan row of every upload, classified when it was processed.
-- in_expected is 1 only when the matched person was in the frozen expected
-- population for this upload's scope. A matched person outside it is
-- in_expected 0 (out of scope); an unmatched row keeps person_id NULL.
-- Classification is stored, not re-derived, so later changes to department
-- assignments cannot silently rewrite a week that was already processed.
CREATE TABLE IF NOT EXISTS mass_scans (
  id CHAR(36) NOT NULL,
  mass_week_id CHAR(36) NOT NULL,
  upload_id CHAR(36) NOT NULL,
  participant_type ENUM('student', 'staff') NOT NULL,
  scan_number VARCHAR(64) NULL,
  scanned_name VARCHAR(160) NULL,
  scanned_at DATETIME(3) NOT NULL,
  person_id CHAR(36) NULL,
  match_method ENUM('number', 'name', 'none') NOT NULL DEFAULT 'none',
  in_expected TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY mass_scans_week_idx (mass_week_id),
  KEY mass_scans_week_person_idx (mass_week_id, participant_type, person_id),
  KEY mass_scans_upload_idx (upload_id),
  CONSTRAINT mass_scans_week_fkey FOREIGN KEY (mass_week_id) REFERENCES mass_weeks (id) ON DELETE CASCADE,
  CONSTRAINT mass_scans_upload_fkey FOREIGN KEY (upload_id) REFERENCES mass_uploads (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Sync bookkeeping and staff presence overrides ---------------------------
--
-- Added in db/migrations/002 and 003 for the SQLite build but never carried
-- into this file, which left a MySQL install created from an earlier version
-- of the file without them. They belong to sync and to the staff override
-- feature, not to any event, so they sit together here.

-- Staff who are credited present at every staff event without a scan. The key
-- is the derived scan number -- the digits of staff_no, exactly as the machine
-- prints them -- because that is the only form a real scan ever arrives in.
-- The three built-ins are seeded below; an operator can add normal rows.
CREATE TABLE IF NOT EXISTS staff_presence_overrides (
  scan_number VARCHAR(64) NOT NULL,
  reason TEXT NOT NULL,
  is_builtin TINYINT(1) NOT NULL DEFAULT 0,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (scan_number),
  CONSTRAINT staff_presence_overrides_user_fkey FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- The three ICT Unit staff who are expected at every staff event whether or
-- not the machine saw them. reason is written as the reason an auditor would
-- want to read, not as a code. IGNORE, not a plain INSERT: an install that
-- already has them would otherwise fail the whole file on the duplicate key.
INSERT IGNORE INTO staff_presence_overrides (scan_number, reason, is_builtin) VALUES
  ('1500', 'Credited present at every staff event without a scan (ICT Unit).', 1),
  ('140',  'Credited present at every staff event without a scan (ICT Unit).', 1),
  ('979',  'Credited present at every staff event without a scan (ICT Unit).', 1);

-- This device's identity and the last thing it heard from the hub, so sync
-- can be resumed and inspected. One row per key. Neither table is a copy of
-- any synced table: they are about the sync itself. `key` is a MySQL reserved
-- word and is quoted here; the app's sync queries quote it the same way.
CREATE TABLE IF NOT EXISTS sync_meta (
  `key` VARCHAR(191) NOT NULL,
  `value` TEXT NOT NULL,
  PRIMARY KEY (`key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Every successful run, so the Synchronize page can show what the last one
-- did. device_id is the row's own uuid, not a foreign key: the hub stores no
-- device table the local one could reference.
CREATE TABLE IF NOT EXISTS sync_log (
  id CHAR(36) NOT NULL,
  synced_at DATETIME(3) NOT NULL,
  device_id CHAR(36) NOT NULL,
  pushed INT NOT NULL DEFAULT 0,
  pulled INT NOT NULL DEFAULT 0,
  notes TEXT NULL,
  PRIMARY KEY (id),
  KEY sync_log_synced_idx (synced_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Upgrades ---------------------------------------------------------------
--
-- The CREATE TABLE statements above are skipped when a table already exists,
-- so later changes to an existing table are applied here instead. Every
-- statement is idempotent, so re-running `npm run db:migrate` is safe.
-- (IF NOT EXISTS on ALTER TABLE needs MariaDB 10.0+ or MySQL 8.0.29+.)

-- The first version of this project used one `people` table for students and
-- staff together. They are separate now, so the old tables are dropped; the
-- data in them was replaced by the CSV imports.
DROP TABLE IF EXISTS import_rows;
DROP TABLE IF EXISTS attendance_imports;
DROP TABLE IF EXISTS attendance_records;
DROP TABLE IF EXISTS session_population;
DROP TABLE IF EXISTS attendance_sessions;
DROP TABLE IF EXISTS people;

-- The edit stamps sync arbitrates "most recent edit wins" with. The CREATE
-- statements above carry them for a fresh database; an install that predates
-- them gets them here, and existing rows are stamped with the moment the
-- column arrived, which is honest enough: nothing older was ever edited under
-- a stamp, and every later write goes through the app's own utcStamp().
ALTER TABLE students ADD COLUMN IF NOT EXISTS updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE staff ADD COLUMN IF NOT EXISTS updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE student_events ADD COLUMN IF NOT EXISTS updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE staff_events ADD COLUMN IF NOT EXISTS updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
ALTER TABLE user_roles ADD COLUMN IF NOT EXISTS updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

-- The registrar's department name and marital status, stored as written. This
-- department is what every scope, filter and Mass assignment uses. 'Religious'
-- in marital_status removes a student from Sunday Mass expected populations
-- only (src/server/mass.ts); weekday Mass is unchanged.
ALTER TABLE students ADD COLUMN IF NOT EXISTS department VARCHAR(120) NULL;
ALTER TABLE students ADD COLUMN IF NOT EXISTS marital_status VARCHAR(32) NULL;

-- The number the attendance machine prints for a member of staff, from the
-- registrar's staff file. Stored rather than derived so a change of staff number
-- cannot change who a scan means; matching falls back to the digits of staff_no
-- for rows the file does not cover.
ALTER TABLE staff ADD COLUMN IF NOT EXISTS machine_id VARCHAR(64) NULL;

-- Widen the department columns from the old 32-character limit (sized for the
-- short codes CSC, ECO, ...) to hold the registrar's full names, the longest of
-- which is 37 characters now ("Pharmacology And Toxicology."). MODIFY is not
-- IF NOT EXISTS-guarded, but widening an already-wider column is a no-op, so
-- re-running the migration is still safe.
ALTER TABLE students MODIFY COLUMN department VARCHAR(120) NULL;
ALTER TABLE staff MODIFY COLUMN department VARCHAR(120) NULL;
ALTER TABLE staff MODIFY COLUMN admin_department VARCHAR(120) NULL;
ALTER TABLE student_events MODIFY COLUMN department_code VARCHAR(120) NULL;
ALTER TABLE recurring_schedules MODIFY COLUMN department_code VARCHAR(120) NULL;
ALTER TABLE student_event_departments MODIFY COLUMN department_code VARCHAR(120) NOT NULL;
ALTER TABLE mass_department_weekdays MODIFY COLUMN department_code VARCHAR(120) NOT NULL;
