-- Built-in sync between computers, version 17.
--
-- No extra software: one computer is "Main", the others ("members") keep their
-- own copy and exchange changes with Main over the office network
-- (src/server/peer.ts).
--
-- Every insert, update and delete on a shared table is recorded here by the
-- triggers below, as the table and the row's key. A sync sends the current state
-- of each recorded row (or "deleted" when the row is gone), so edits, review
-- answers and deletions travel as well as new rows.
--
-- While a sync is applying rows it received, sync_apply says so: on a member the
-- triggers stay quiet (Main already has those changes); on Main they record the
-- change with the member it came from (origin), so the other members get it and
-- the member it came from does not get it back.

CREATE TABLE change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  tbl TEXT NOT NULL,
  pk TEXT NOT NULL,
  origin TEXT
);
CREATE INDEX change_log_origin_idx ON change_log (origin, seq);

CREATE TABLE sync_apply (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  suppress INTEGER NOT NULL DEFAULT 0,
  origin TEXT
);
INSERT INTO sync_apply (id, suppress, origin) VALUES (1, 0, NULL);

-- This computer's part: 'off', 'main' or 'member'.
CREATE TABLE peer_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  role TEXT NOT NULL DEFAULT 'off',
  device_id TEXT NOT NULL,
  device_name TEXT,
  pairing_code TEXT,
  main_address TEXT,
  main_name TEXT,
  main_device_id TEXT,
  pushed_seq INTEGER NOT NULL DEFAULT 0,
  pulled_seq INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  last_result TEXT,
  last_error TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO peer_settings (id, role, device_id)
VALUES (1, 'off', lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-' ||
        lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(2))) || '-' || lower(hex(randomblob(6))));

-- The same person created on two computers has two ids. When a row arrives
-- whose staff number / matric number / email is already here under another id,
-- the two are paired and references to the other id are read as this one.
CREATE TABLE peer_id_map (
  kind TEXT NOT NULL,
  foreign_id TEXT NOT NULL,
  local_id TEXT NOT NULL,
  PRIMARY KEY (kind, foreign_id)
);

-- On Main: the computers that have synced with it.
CREATE TABLE peer_devices (
  device_id TEXT PRIMARY KEY,
  device_name TEXT,
  address TEXT,
  last_seen_at TEXT
);

CREATE TRIGGER change_log_users_insert AFTER INSERT ON users
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('users', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_users_update AFTER UPDATE ON users
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('users', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_users_delete AFTER DELETE ON users
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('users', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_profiles_insert AFTER INSERT ON profiles
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('profiles', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_profiles_update AFTER UPDATE ON profiles
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('profiles', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_profiles_delete AFTER DELETE ON profiles
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('profiles', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_user_roles_insert AFTER INSERT ON user_roles
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('user_roles', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_user_roles_update AFTER UPDATE ON user_roles
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('user_roles', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_user_roles_delete AFTER DELETE ON user_roles
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('user_roles', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_students_insert AFTER INSERT ON students
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('students', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_students_update AFTER UPDATE ON students
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('students', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_students_delete AFTER DELETE ON students
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('students', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_insert AFTER INSERT ON staff
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_update AFTER UPDATE ON staff
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_delete AFTER DELETE ON staff
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_presence_overrides_insert AFTER INSERT ON staff_presence_overrides
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_presence_overrides', json_object('scan_number', NEW.scan_number), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_presence_overrides_update AFTER UPDATE ON staff_presence_overrides
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_presence_overrides', json_object('scan_number', NEW.scan_number), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_presence_overrides_delete AFTER DELETE ON staff_presence_overrides
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_presence_overrides', json_object('scan_number', OLD.scan_number), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_templates_insert AFTER INSERT ON recurring_templates
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_templates', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_templates_update AFTER UPDATE ON recurring_templates
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_templates', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_templates_delete AFTER DELETE ON recurring_templates
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_templates', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_schedules_insert AFTER INSERT ON recurring_schedules
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_schedules', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_schedules_update AFTER UPDATE ON recurring_schedules
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_schedules', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_schedules_delete AFTER DELETE ON recurring_schedules
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_schedules', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_schedule_departments_insert AFTER INSERT ON recurring_schedule_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_schedule_departments', json_object('schedule_id', NEW.schedule_id, 'department', NEW.department), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_schedule_departments_update AFTER UPDATE ON recurring_schedule_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_schedule_departments', json_object('schedule_id', NEW.schedule_id, 'department', NEW.department), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_recurring_schedule_departments_delete AFTER DELETE ON recurring_schedule_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('recurring_schedule_departments', json_object('schedule_id', OLD.schedule_id, 'department', OLD.department), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_events_insert AFTER INSERT ON student_events
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_events', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_events_update AFTER UPDATE ON student_events
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_events', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_events_delete AFTER DELETE ON student_events
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_events', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_event_departments_insert AFTER INSERT ON student_event_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_event_departments', json_object('event_id', NEW.event_id, 'department_code', NEW.department_code), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_event_departments_update AFTER UPDATE ON student_event_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_event_departments', json_object('event_id', NEW.event_id, 'department_code', NEW.department_code), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_event_departments_delete AFTER DELETE ON student_event_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_event_departments', json_object('event_id', OLD.event_id, 'department_code', OLD.department_code), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_events_insert AFTER INSERT ON staff_events
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_events', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_events_update AFTER UPDATE ON staff_events
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_events', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_events_delete AFTER DELETE ON staff_events
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_events', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_event_departments_insert AFTER INSERT ON staff_event_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_event_departments', json_object('event_id', NEW.event_id, 'department', NEW.department), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_event_departments_update AFTER UPDATE ON staff_event_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_event_departments', json_object('event_id', NEW.event_id, 'department', NEW.department), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_event_departments_delete AFTER DELETE ON staff_event_departments
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_event_departments', json_object('event_id', OLD.event_id, 'department', OLD.department), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_event_uploads_insert AFTER INSERT ON student_event_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_event_uploads', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_event_uploads_update AFTER UPDATE ON student_event_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_event_uploads', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_event_uploads_delete AFTER DELETE ON student_event_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_event_uploads', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_event_uploads_insert AFTER INSERT ON staff_event_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_event_uploads', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_event_uploads_update AFTER UPDATE ON staff_event_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_event_uploads', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_event_uploads_delete AFTER DELETE ON staff_event_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_event_uploads', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_scans_insert AFTER INSERT ON student_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_scans', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_scans_update AFTER UPDATE ON student_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_scans', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_student_scans_delete AFTER DELETE ON student_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('student_scans', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_scans_insert AFTER INSERT ON staff_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_scans', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_scans_update AFTER UPDATE ON staff_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_scans', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_staff_scans_delete AFTER DELETE ON staff_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('staff_scans', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_department_weekdays_insert AFTER INSERT ON mass_department_weekdays
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_department_weekdays', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_department_weekdays_update AFTER UPDATE ON mass_department_weekdays
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_department_weekdays', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_department_weekdays_delete AFTER DELETE ON mass_department_weekdays
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_department_weekdays', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_weeks_insert AFTER INSERT ON mass_weeks
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_weeks', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_weeks_update AFTER UPDATE ON mass_weeks
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_weeks', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_weeks_delete AFTER DELETE ON mass_weeks
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_weeks', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_week_weekdays_insert AFTER INSERT ON mass_week_weekdays
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_week_weekdays', json_object('mass_week_id', NEW.mass_week_id, 'day_of_week', NEW.day_of_week), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_week_weekdays_update AFTER UPDATE ON mass_week_weekdays
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_week_weekdays', json_object('mass_week_id', NEW.mass_week_id, 'day_of_week', NEW.day_of_week), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_week_weekdays_delete AFTER DELETE ON mass_week_weekdays
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_week_weekdays', json_object('mass_week_id', OLD.mass_week_id, 'day_of_week', OLD.day_of_week), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_expected_insert AFTER INSERT ON mass_expected
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_expected', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_expected_update AFTER UPDATE ON mass_expected
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_expected', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_expected_delete AFTER DELETE ON mass_expected
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_expected', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_uploads_insert AFTER INSERT ON mass_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_uploads', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_uploads_update AFTER UPDATE ON mass_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_uploads', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_uploads_delete AFTER DELETE ON mass_uploads
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_uploads', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_scans_insert AFTER INSERT ON mass_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_scans', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_scans_update AFTER UPDATE ON mass_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_scans', json_object('id', NEW.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_mass_scans_delete AFTER DELETE ON mass_scans
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('mass_scans', json_object('id', OLD.id), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_scan_aliases_insert AFTER INSERT ON scan_aliases
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('scan_aliases', json_object('kind', NEW.kind, 'scan_number', NEW.scan_number, 'name_key', NEW.name_key), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_scan_aliases_update AFTER UPDATE ON scan_aliases
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('scan_aliases', json_object('kind', NEW.kind, 'scan_number', NEW.scan_number, 'name_key', NEW.name_key), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_scan_aliases_delete AFTER DELETE ON scan_aliases
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('scan_aliases', json_object('kind', OLD.kind, 'scan_number', OLD.scan_number, 'name_key', OLD.name_key), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_distinct_people_insert AFTER INSERT ON distinct_people
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('distinct_people', json_object('kind', NEW.kind, 'person_a', NEW.person_a, 'person_b', NEW.person_b), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_distinct_people_update AFTER UPDATE ON distinct_people
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('distinct_people', json_object('kind', NEW.kind, 'person_a', NEW.person_a, 'person_b', NEW.person_b), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_distinct_people_delete AFTER DELETE ON distinct_people
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('distinct_people', json_object('kind', OLD.kind, 'person_a', OLD.person_a, 'person_b', OLD.person_b), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_debt_rates_insert AFTER INSERT ON debt_rates
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('debt_rates', json_object('participant_type', NEW.participant_type), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_debt_rates_update AFTER UPDATE ON debt_rates
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('debt_rates', json_object('participant_type', NEW.participant_type), (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_debt_rates_delete AFTER DELETE ON debt_rates
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('debt_rates', json_object('participant_type', OLD.participant_type), (SELECT origin FROM sync_apply WHERE id = 1));
END;

-- Everything already here counts as a change, so the first sync sends it all.
INSERT INTO change_log (tbl, pk, origin) SELECT 'users', json_object('id', id), NULL FROM users;
INSERT INTO change_log (tbl, pk, origin) SELECT 'profiles', json_object('id', id), NULL FROM profiles;
INSERT INTO change_log (tbl, pk, origin) SELECT 'user_roles', json_object('id', id), NULL FROM user_roles;
INSERT INTO change_log (tbl, pk, origin) SELECT 'students', json_object('id', id), NULL FROM students;
INSERT INTO change_log (tbl, pk, origin) SELECT 'staff', json_object('id', id), NULL FROM staff;
INSERT INTO change_log (tbl, pk, origin) SELECT 'staff_presence_overrides', json_object('scan_number', scan_number), NULL FROM staff_presence_overrides;
INSERT INTO change_log (tbl, pk, origin) SELECT 'recurring_templates', json_object('id', id), NULL FROM recurring_templates;
INSERT INTO change_log (tbl, pk, origin) SELECT 'recurring_schedules', json_object('id', id), NULL FROM recurring_schedules;
INSERT INTO change_log (tbl, pk, origin) SELECT 'recurring_schedule_departments', json_object('schedule_id', schedule_id, 'department', department), NULL FROM recurring_schedule_departments;
INSERT INTO change_log (tbl, pk, origin) SELECT 'student_events', json_object('id', id), NULL FROM student_events;
INSERT INTO change_log (tbl, pk, origin) SELECT 'student_event_departments', json_object('event_id', event_id, 'department_code', department_code), NULL FROM student_event_departments;
INSERT INTO change_log (tbl, pk, origin) SELECT 'staff_events', json_object('id', id), NULL FROM staff_events;
INSERT INTO change_log (tbl, pk, origin) SELECT 'staff_event_departments', json_object('event_id', event_id, 'department', department), NULL FROM staff_event_departments;
INSERT INTO change_log (tbl, pk, origin) SELECT 'student_event_uploads', json_object('id', id), NULL FROM student_event_uploads;
INSERT INTO change_log (tbl, pk, origin) SELECT 'staff_event_uploads', json_object('id', id), NULL FROM staff_event_uploads;
INSERT INTO change_log (tbl, pk, origin) SELECT 'student_scans', json_object('id', id), NULL FROM student_scans;
INSERT INTO change_log (tbl, pk, origin) SELECT 'staff_scans', json_object('id', id), NULL FROM staff_scans;
INSERT INTO change_log (tbl, pk, origin) SELECT 'mass_department_weekdays', json_object('id', id), NULL FROM mass_department_weekdays;
INSERT INTO change_log (tbl, pk, origin) SELECT 'mass_weeks', json_object('id', id), NULL FROM mass_weeks;
INSERT INTO change_log (tbl, pk, origin) SELECT 'mass_week_weekdays', json_object('mass_week_id', mass_week_id, 'day_of_week', day_of_week), NULL FROM mass_week_weekdays;
INSERT INTO change_log (tbl, pk, origin) SELECT 'mass_expected', json_object('id', id), NULL FROM mass_expected;
INSERT INTO change_log (tbl, pk, origin) SELECT 'mass_uploads', json_object('id', id), NULL FROM mass_uploads;
INSERT INTO change_log (tbl, pk, origin) SELECT 'mass_scans', json_object('id', id), NULL FROM mass_scans;
INSERT INTO change_log (tbl, pk, origin) SELECT 'scan_aliases', json_object('kind', kind, 'scan_number', scan_number, 'name_key', name_key), NULL FROM scan_aliases;
INSERT INTO change_log (tbl, pk, origin) SELECT 'distinct_people', json_object('kind', kind, 'person_a', person_a, 'person_b', person_b), NULL FROM distinct_people;
INSERT INTO change_log (tbl, pk, origin) SELECT 'debt_rates', json_object('participant_type', participant_type), NULL FROM debt_rates;
