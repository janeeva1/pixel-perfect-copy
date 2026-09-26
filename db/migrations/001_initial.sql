-- Attendance Register — SQLite schema.
--
-- Applied by `npm run db:migrate`, which runs every file in db/migrations in
-- name order and records what it has applied in the database's own
-- `user_version`. Each file is applied exactly once, ever. That is the whole
-- point of the numbering: SQLite cannot do `ALTER TABLE ... ADD COLUMN IF NOT
-- EXISTS`, so an already-installed copy of the app must be able to tell "I have
-- had this change" from "I have not" without re-running it, and a numbered file
-- is the only way to say that.
--
-- Translated from the MySQL schema this replaces:
--   ENUM(...)          -> TEXT plus a CHECK constraint, so a bad value is still
--                         rejected rather than silently stored
--   DATETIME(3)/DATE/TIME -> TEXT, holding 'YYYY-MM-DD HH:MM:SS' in UTC and
--                         'YYYY-MM-DD' / 'HH:MM:SS' respectively. SQLite has no
--                         date types; the strings sort and compare correctly,
--                         which is all the queries ask of them.
--   inline UNIQUE KEY / KEY -> separate CREATE INDEX statements
--   ENGINE/CHARSET/COLLATE -> dropped; the connection sets the encoding, and
--                         case-insensitive columns are declared COLLATE NOCASE
--   ON UPDATE CURRENT_TIMESTAMP -> dropped. SQLite has no equivalent, and a
--                         column that silently changes itself is worse than one
--                         the code writes on purpose. recurring_templates sets
--                         updated_at in its UPDATE statements.
--
-- Design notes carried over unchanged:
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
--     See studentDepartmentSql() and studentCategorySql() in src/server/masters.ts.
--   * Attendance is never stored on a person. Present, absent, out of scope and
--     unmatched are recalculated from the master list every time a report runs,
--     so a corrected import fixes history without touching the scans.
--   * Events, uploads and scans are duplicated per group on purpose, so a
--     student report never has to branch on a "person type" column.

-- Accounts ---------------------------------------------------------------

CREATE TABLE users (
  id TEXT NOT NULL PRIMARY KEY,
  -- COLLATE NOCASE: the MySQL schema was utf8mb4_unicode_ci, so 'A@b.com' and
  -- 'a@b.com' were the same account. Sign-in looks an account up by email, so
  -- losing that would let one person be created twice.
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE profiles (
  id TEXT NOT NULL PRIMARY KEY,
  full_name TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (id) REFERENCES users (id) ON DELETE CASCADE
);

CREATE TABLE user_roles (
  id TEXT NOT NULL PRIMARY KEY,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'operator', 'viewer')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (user_id, role),
  FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
);
CREATE INDEX user_roles_role_idx ON user_roles (role);

CREATE TABLE audit_logs (
  id TEXT NOT NULL PRIMARY KEY,
  actor_id TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  -- The MySQL schema used a JSON column. Nothing ever queries inside this one, it
  -- is only ever written as a JSON string, so TEXT holds it unchanged, and the
  -- rule that it really is JSON is kept as a CHECK so both engines reject the
  -- same rows. `details IS NULL OR` is there because json_valid(NULL) is NULL,
  -- and a CHECK passes on NULL: without it a log row with no details would be
  -- allowed by accident rather than by intent.
  details TEXT CHECK (details IS NULL OR json_valid(details)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_id) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX audit_logs_created_idx ON audit_logs (created_at);
CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id);

-- Master data ------------------------------------------------------------
--
-- student_db.csv  id, lname, fname, mname, matric_no, level
-- staff_db.csv    id, lname, fname, mname, staff_no
--
-- These tables mirror the file and nothing else. See the notes in the header.

CREATE TABLE students (
  id TEXT NOT NULL PRIMARY KEY,
  matric_no TEXT NOT NULL UNIQUE,
  last_name TEXT,
  first_name TEXT,
  middle_name TEXT,
  level TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX students_level_idx ON students (level);
CREATE INDEX students_last_name_idx ON students (last_name);
CREATE INDEX students_first_name_idx ON students (first_name);

-- staff_no is the natural key, since it is the one identifier the staff file
-- always supplies and it is distinct on all 1,112 rows that have one. Two rows
-- carry the literal text NULL, which is read as "no staff number" and stored as
-- NULL; NULLs do not collide in a unique index, so both are kept.
--
-- department and admin_department are COLLATE NOCASE because the staff
-- department is free text spelled differently per row and a department-scoped
-- report matches it case-insensitively (see staffDepartmentSql() and the note in
-- src/server/reports.ts). The MySQL utf8mb4_unicode_ci collation gave that for
-- free; here it has to be declared.
CREATE TABLE staff (
  id TEXT NOT NULL PRIMARY KEY,
  staff_no TEXT UNIQUE,
  last_name TEXT,
  first_name TEXT,
  middle_name TEXT,
  faculty TEXT,
  department TEXT COLLATE NOCASE,
  admin_department TEXT COLLATE NOCASE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX staff_department_idx ON staff (department);
CREATE INDEX staff_admin_department_idx ON staff (admin_department);
CREATE INDEX staff_last_name_idx ON staff (last_name);
CREATE INDEX staff_first_name_idx ON staff (first_name);

-- Student events ---------------------------------------------------------
--
-- An event is one attendance exercise on one date, narrowed to a scope: a
-- category (undergraduate/postgraduate), a level, a department, or any
-- combination. "Expected" is everyone matching the scope, recalculated live from
-- the master list, so it is never stored here. start_time/end_time are advisory:
-- they are shown on reports and used to flag scans that fall outside the event
-- window, but an upload always counts.

CREATE TABLE student_events (
  id TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  student_category TEXT CHECK (student_category IN ('undergraduate', 'postgraduate')),
  level TEXT,
  department_code TEXT COLLATE NOCASE,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  created_by TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Event category: a Community Mass, or anything else. The reports and the
  -- dashboard are broken down by this, so it is stored rather than guessed from
  -- the title: renaming an event must never move it between categories, and a
  -- Mass event whose title happens not to say "Mass" must still be found.
  event_category TEXT NOT NULL DEFAULT 'other' CHECK (event_category IN ('community_mass', 'other')),
  -- Link back to the template and schedule that generated this event, if any.
  template_id TEXT,
  schedule_id TEXT,
  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX student_events_date_idx ON student_events (event_date);
CREATE INDEX student_events_status_idx ON student_events (status);
CREATE INDEX student_events_category_idx ON student_events (event_category, event_date);
CREATE INDEX student_events_template_idx ON student_events (template_id);
CREATE INDEX student_events_schedule_idx ON student_events (schedule_id);

-- One row per uploaded machine file. An event can have many: clock-in, then
-- clock-out, then a re-export.
CREATE TABLE student_event_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  label TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  present_count INTEGER NOT NULL DEFAULT 0,
  out_of_scope_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES student_events (id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX student_uploads_event_idx ON student_event_uploads (event_id);

-- Every scan row is kept, so clock-in and clock-out can both be shown and
-- repeat scans are visible instead of being collapsed away. student_id is null
-- when the number on the scan could not be resolved to a student in this
-- event's scope; scanned_name and scan_number are kept so the row can be
-- looked up by hand. This is the only table that holds a number the machine
-- printed: it is the scan's own value, not a copy of anything in the master.
CREATE TABLE student_scans (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  scan_number TEXT,
  scanned_name TEXT,
  scanned_at TEXT NOT NULL,
  student_id TEXT,
  match_method TEXT NOT NULL DEFAULT 'none' CHECK (match_method IN ('number', 'name', 'none')),
  in_scope INTEGER NOT NULL DEFAULT 0,
  outside_window INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES student_events (id) ON DELETE CASCADE,
  FOREIGN KEY (upload_id) REFERENCES student_event_uploads (id) ON DELETE CASCADE,
  FOREIGN KEY (student_id) REFERENCES students (id) ON DELETE SET NULL
);
CREATE INDEX student_scans_event_idx ON student_scans (event_id);
CREATE INDEX student_scans_event_student_idx ON student_scans (event_id, student_id);
CREATE INDEX student_scans_time_idx ON student_scans (scanned_at);
CREATE INDEX student_scans_number_idx ON student_scans (scan_number);
CREATE INDEX student_scans_upload_idx ON student_scans (upload_id);

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

CREATE TABLE staff_events (
  id TEXT NOT NULL PRIMARY KEY,
  title TEXT NOT NULL,
  event_date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'finalized')),
  created_by TEXT,
  finalized_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  event_category TEXT NOT NULL DEFAULT 'other' CHECK (event_category IN ('community_mass', 'other')),
  template_id TEXT,
  schedule_id TEXT,
  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX staff_events_date_idx ON staff_events (event_date);
CREATE INDEX staff_events_status_idx ON staff_events (status);
CREATE INDEX staff_events_category_idx ON staff_events (event_category, event_date);
CREATE INDEX staff_events_template_idx ON staff_events (template_id);
CREATE INDEX staff_events_schedule_idx ON staff_events (schedule_id);

CREATE TABLE staff_event_uploads (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  label TEXT,
  row_count INTEGER NOT NULL DEFAULT 0,
  present_count INTEGER NOT NULL DEFAULT 0,
  out_of_scope_count INTEGER NOT NULL DEFAULT 0,
  unmatched_count INTEGER NOT NULL DEFAULT 0,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (event_id) REFERENCES staff_events (id) ON DELETE CASCADE,
  FOREIGN KEY (uploaded_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX staff_uploads_event_idx ON staff_event_uploads (event_id);

CREATE TABLE staff_scans (
  id TEXT NOT NULL PRIMARY KEY,
  event_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  scan_number TEXT,
  scanned_name TEXT,
  scanned_at TEXT NOT NULL,
  staff_id TEXT,
  match_method TEXT NOT NULL DEFAULT 'none' CHECK (match_method IN ('number', 'name', 'none')),
  in_scope INTEGER NOT NULL DEFAULT 0,
  outside_window INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (event_id) REFERENCES staff_events (id) ON DELETE CASCADE,
  FOREIGN KEY (upload_id) REFERENCES staff_event_uploads (id) ON DELETE CASCADE,
  FOREIGN KEY (staff_id) REFERENCES staff (id) ON DELETE SET NULL
);
CREATE INDEX staff_scans_event_idx ON staff_scans (event_id);
CREATE INDEX staff_scans_event_staff_idx ON staff_scans (event_id, staff_id);
CREATE INDEX staff_scans_time_idx ON staff_scans (scanned_at);
CREATE INDEX staff_scans_number_idx ON staff_scans (scan_number);
CREATE INDEX staff_scans_upload_idx ON staff_scans (upload_id);

-- Recurring event templates ----------------------------------------------
-- A template defines a repeating weekly pattern (e.g., Community Mass).
-- It generates concrete events for a semester date range. group_kind says which
-- master list the generated events are drawn from, because a student event and a
-- staff event are different tables with different scopes.

CREATE TABLE recurring_templates (
  id TEXT NOT NULL PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  group_kind TEXT NOT NULL DEFAULT 'student' CHECK (group_kind IN ('student', 'staff')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  event_title_template TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  notes TEXT,
  event_category TEXT NOT NULL DEFAULT 'other' CHECK (event_category IN ('community_mass', 'other')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  -- Written explicitly by the update statements; see the header note on
  -- ON UPDATE CURRENT_TIMESTAMP.
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL
);
CREATE INDEX recurring_templates_date_idx ON recurring_templates (start_date, end_date);

-- Weekly schedule entries for a template.
-- day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday
-- scope is expressed as category/level/departments (same as the events)
--
-- A day can cover several departments, so the departments live in their own
-- table rather than in one department_code column. They are free text on the
-- staff side ("Medical Sciences"), so a delimiter would be a latent bug the
-- first department with a comma in its name would trigger.

CREATE TABLE recurring_schedules (
  id TEXT NOT NULL PRIMARY KEY,
  template_id TEXT NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  student_category TEXT CHECK (student_category IN ('undergraduate', 'postgraduate')),
  level TEXT,
  title_suffix TEXT,
  department_code TEXT COLLATE NOCASE,
  FOREIGN KEY (template_id) REFERENCES recurring_templates (id) ON DELETE CASCADE
);
CREATE INDEX recurring_schedules_template_idx ON recurring_schedules (template_id);

-- Departments expected on one scheduled day. A student code (CSC) on a student
-- template, a department name on a staff template. Empty means everyone.
CREATE TABLE recurring_schedule_departments (
  schedule_id TEXT NOT NULL,
  department TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (schedule_id, department),
  FOREIGN KEY (schedule_id) REFERENCES recurring_schedules (id) ON DELETE CASCADE
);
CREATE INDEX recurring_schedule_departments_dept_idx ON recurring_schedule_departments (department);

-- Multi-department scope for events. An event with no row here is unscoped and
-- expects everyone, which is how every event behaved before this existed.
-- student_events.department_code stays as the single-department shorthand and is
-- kept in step for the first department, so older readers and the CSV label
-- still show something sensible.

CREATE TABLE student_event_departments (
  event_id TEXT NOT NULL,
  department_code TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (event_id, department_code),
  FOREIGN KEY (event_id) REFERENCES student_events (id) ON DELETE CASCADE
);
CREATE INDEX student_event_departments_dept_idx ON student_event_departments (department_code);

CREATE TABLE staff_event_departments (
  event_id TEXT NOT NULL,
  department TEXT NOT NULL COLLATE NOCASE,
  PRIMARY KEY (event_id, department),
  FOREIGN KEY (event_id) REFERENCES staff_events (id) ON DELETE CASCADE
);
CREATE INDEX staff_event_departments_dept_idx ON staff_event_departments (department);
