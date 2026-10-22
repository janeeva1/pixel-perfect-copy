-- Student department and marital status, version 6.
--
-- The registrar's student file carries two columns the master table did not
-- keep: the department's full name ("Computer Engineering") and the student's
-- marital status. Both are now stored as written.
--
--   department     Display metadata. The department code every scope, filter
--                  and Mass assignment uses (CEG, SEN, MLS...) is still
--                  derived from matric_no in SQL and is not affected by this
--                  column; the students page shows the stored name when the
--                  file had one and falls back to the derived code.
--   marital_status From the same file, when the file has one. 'Religious'
--                  students are excluded from Sunday Mass expected
--                  populations (src/server/mass.ts, buildStudentSnapshot);
--                  weekday Mass and every other report include them as usual.
--
-- SQLite cannot ADD COLUMN IF NOT EXISTS, so this file is applied once, ever.
ALTER TABLE students ADD COLUMN department TEXT COLLATE NOCASE;
ALTER TABLE students ADD COLUMN marital_status TEXT;
