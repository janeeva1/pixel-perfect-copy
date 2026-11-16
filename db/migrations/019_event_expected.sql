-- Closed events keep their expected list, version 19.
--
-- While an event is open, who is expected is worked out from the staff or
-- student list as it is now. When an administrator closes it ("Close - stop
-- counting"), the people expected at that moment are written here, and the
-- event's results are read from this list from then on. Someone added to the
-- staff or student list later is therefore never counted absent (or present)
-- at an event that was already over. Reopening the event removes the list.
CREATE TABLE event_expected (
  kind TEXT NOT NULL CHECK (kind IN ('staff', 'student')),
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  PRIMARY KEY (kind, event_id, person_id)
);
CREATE INDEX event_expected_event_idx ON event_expected (event_id);

CREATE TRIGGER change_log_event_expected_insert AFTER INSERT ON event_expected
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('event_expected',
          json_object('kind', NEW.kind, 'event_id', NEW.event_id, 'person_id', NEW.person_id),
          (SELECT origin FROM sync_apply WHERE id = 1));
END;

CREATE TRIGGER change_log_event_expected_delete AFTER DELETE ON event_expected
WHEN (SELECT suppress FROM sync_apply WHERE id = 1) = 0
BEGIN
  INSERT INTO change_log (tbl, pk, origin)
  VALUES ('event_expected',
          json_object('kind', OLD.kind, 'event_id', OLD.event_id, 'person_id', OLD.person_id),
          (SELECT origin FROM sync_apply WHERE id = 1));
END;
