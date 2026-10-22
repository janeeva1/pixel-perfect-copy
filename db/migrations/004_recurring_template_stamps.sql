-- Normalise the recurring template edit stamps, version 4.
--
-- Sync decides "most recent edit wins" by comparing `updated_at` as text, which
-- only works when both ends hold the same shape. Every other stamped table gets
-- 'YYYY-MM-DD HH:MM:SS.mmm' from utcStamp() (src/server/db.ts) and from the
-- backfill in 003. recurring_templates did not: it was written by a hand-rolled
-- `.slice(0, 19)` that stopped at the seconds.
--
-- That is a real defect once the table is synced. A hub DATETIME(3) column comes
-- back as 'YYYY-MM-DD HH:MM:SS.mmm', and '2026-09-28 16:00:00' sorts *before*
-- '2026-09-28 16:00:00.000', so an edited template would always lose to an
-- untouched copy of itself and the edit could never propagate.
--
-- New rows are written with utcStamp() as of this change. This only rewrites the
-- rows that already exist, and it is a no-op for any value that is already 23
-- characters. recurring_schedules and recurring_schedule_departments carry no
-- stamp at all: a schedule row is replaced wholesale by its template's save, so
-- there is nothing meaningful to arbitrate and sync merges them by id.

-- Idempotent: the value is 23 characters once this has run, so it stops matching.
UPDATE recurring_templates
   SET updated_at = updated_at || '.000'
 WHERE LENGTH(updated_at) = 19;