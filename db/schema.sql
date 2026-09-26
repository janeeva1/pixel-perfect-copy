-- Attendance Register — local MySQL/MariaDB schema.
-- Applied by `npm run db:migrate` (db/migrate.mjs). Every statement is
-- CREATE ... IF NOT EXISTS, so re-running is safe.
--
-- Design notes:
--   * The two master tables hold only the columns that are in the registrar's
--     files. There is no extra column for whatever number the attendance
--     machine prints, because in both files that number is already derivable
--     from a column that is stored: for a student it is the tail of the matric
--     number, for staff the digits of the staff number. The derivations are in
--     src/server/masters.ts (studentScanNumberSql, staffScanNumberSql).
--     Level comes from the file. The undergraduate/postgraduate category and
--     the department are read out of the matric number whenever they are
--     needed, so they are not stored:
--       VUG/CSC/18/2633     -> undergraduate, department CSC
--       VPG/PGD/ECO/15/1042 -> postgraduate, department ECO
--     See DEPARTMENT_SQL and CATEGORY_SQL in src/server/masters.ts.
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
  PRIMARY KEY (id),
  CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS user_roles (
  id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('admin', 'operator', 'viewer') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
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
-- Nothing derived is stored. The undergraduate/postgraduate category and the
-- department are worked out from matric_no in SQL (see src/server/masters.ts),
-- so a student row holds only what the file holds.

CREATE TABLE IF NOT EXISTS students (
  id CHAR(36) NOT NULL,
  matric_no VARCHAR(64) NOT NULL,
  last_name VARCHAR(80) NULL,
  first_name VARCHAR(80) NULL,
  middle_name VARCHAR(80) NULL,
  level VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
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
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY staff_no_unique (staff_no)
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
  department_code VARCHAR(32) NULL,
  notes TEXT NULL,
  status ENUM('draft', 'finalized') NOT NULL DEFAULT 'draft',
  created_by CHAR(36) NULL,
  finalized_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
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
  department_code VARCHAR(32) NULL,
  PRIMARY KEY (id),
  KEY recurring_schedules_template_idx (template_id),
  CONSTRAINT recurring_schedules_template_fkey FOREIGN KEY (template_id) REFERENCES recurring_templates (id) ON DELETE CASCADE,
  CONSTRAINT recurring_schedules_day_of_week_chk CHECK (day_of_week BETWEEN 0 AND 6)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Departments expected on one scheduled day. A student code (CSC) on a student
-- template, a department name on a staff template. Empty means everyone.
CREATE TABLE IF NOT EXISTS recurring_schedule_departments (
  schedule_id CHAR(36) NOT NULL,
  department VARCHAR(120) NOT NULL,
  PRIMARY KEY (schedule_id, department),
  KEY recurring_schedule_departments_dept_idx (department),
  CONSTRAINT recurring_schedule_departments_schedule_fkey FOREIGN KEY (schedule_id) REFERENCES recurring_schedules (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Carry an existing install's single department across, so a template that
-- already names a department does not silently widen to everyone when the
-- junction table starts being used. Upper cased for the same reason the
-- backfill of the student events below is: the code comes from a matric number
-- and is worked out in upper case. On a fresh database there is nothing to copy
-- and this inserts no rows.
INSERT IGNORE INTO recurring_schedule_departments (schedule_id, department)
  SELECT id, UPPER(TRIM(department_code)) FROM recurring_schedules
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
  department_code VARCHAR(32) NOT NULL,
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
  SELECT id, UPPER(department_code) FROM student_events
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
