-- Which students a Weekly Mass expects, version 20.
--
-- 'undergraduate' (as before), 'postgraduate', or 'both'. Chosen when the week
-- is created; it can change only while the week has no student files.
ALTER TABLE mass_weeks ADD COLUMN student_category TEXT NOT NULL DEFAULT 'undergraduate';
