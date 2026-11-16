-- Students on the registrar's current list, version 21.
--
-- Importing a student file marked "complete list" sets this to 0 for students
-- not in the file (graduated, withdrawn): they stop being expected at Mass and
-- events, but stay on record and still match a scan. Importing a file that
-- includes them again puts them back.
ALTER TABLE students ADD COLUMN on_current_list INTEGER NOT NULL DEFAULT 1;
