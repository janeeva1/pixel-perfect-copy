-- Recompute the "outside the event window" flag on stored scans, version 14.
--
-- Until now the flag was worked out wrongly at upload time:
--
--   * the event's start and end times were compared with a leading space
--     (" 08:00"), which sorts before every digit, so any event with an end time
--     marked every one of its scans as outside the window;
--   * the scan time was compared in UTC while the event's date and hours are
--     local, which moved the window by the machine's UTC offset and could put a
--     scan near midnight on the wrong day.
--
-- scanned_at is stored in UTC (see toSqlDateTime in src/server/db.ts), so
-- 'localtime' turns it back into the wall-clock time the machine printed on
-- this computer. time() normalises '08:00' to '08:00:00' and is NULL for an
-- unset or unreadable time, in which case that bound is ignored, exactly as
-- the upload code now does. The flag is advisory only: it never changes who is
-- counted present.
UPDATE student_scans
SET outside_window = (
  SELECT CASE
    WHEN date(student_scans.scanned_at, 'localtime') <> e.event_date THEN 1
    WHEN time(e.start_time) IS NOT NULL
      AND time(student_scans.scanned_at, 'localtime') < time(e.start_time) THEN 1
    WHEN time(e.end_time) IS NOT NULL
      AND time(student_scans.scanned_at, 'localtime') > time(e.end_time) THEN 1
    ELSE 0
  END
  FROM student_events e
  WHERE e.id = student_scans.event_id
)
WHERE EXISTS (SELECT 1 FROM student_events e WHERE e.id = student_scans.event_id);

UPDATE staff_scans
SET outside_window = (
  SELECT CASE
    WHEN date(staff_scans.scanned_at, 'localtime') <> e.event_date THEN 1
    WHEN time(e.start_time) IS NOT NULL
      AND time(staff_scans.scanned_at, 'localtime') < time(e.start_time) THEN 1
    WHEN time(e.end_time) IS NOT NULL
      AND time(staff_scans.scanned_at, 'localtime') > time(e.end_time) THEN 1
    ELSE 0
  END
  FROM staff_events e
  WHERE e.id = staff_scans.event_id
)
WHERE EXISTS (SELECT 1 FROM staff_events e WHERE e.id = staff_scans.event_id);
