-- Add new columns to staff table for machine ID matching and additional fields
ALTER TABLE staff ADD COLUMN staff_id_on_machine TEXT;
ALTER TABLE staff ADD COLUMN designation TEXT;
ALTER TABLE staff ADD COLUMN staff_category TEXT;

CREATE INDEX staff_staff_id_on_machine_idx ON staff (staff_id_on_machine);