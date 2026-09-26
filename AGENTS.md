# Notes for AI agents

Local-only attendance register. Keep it that way: no hosted auth, no external
API keys, no cloud database.

## Commands

```
npm run dev        # dev server on http://127.0.0.1:3000
npm run build      # production build into .output/
npm start          # run the production build
npm run db:migrate # create database + tables if missing
npm run db:reset   # drop and rebuild the schema (destroys all data)
npm run typecheck
npm run lint
npm run format
```

## Rules

- Run `npm run typecheck` and `npm run lint` before calling work done.
- Never commit `.env`; it holds the database password and `SESSION_SECRET`.
- All SQL goes through `src/server/db.ts` with bound parameters, never string
  interpolation of user input.
- Authorization lives in `src/server/auth.ts` (`requireSession`,
  `requireEditor`, `requireAdmin`). Adding a route without a guard exposes data.
- API routes return JSON and throw `HttpError` from `src/server/http.ts`.
- Schema changes belong in `db/schema.sql`; bump nothing by hand in the
  database, re-run `npm run db:reset` while developing.

## Do not add these to a person

`students` and `staff` mirror the registrar's files. They are deliberately thin,
and a request to "just add a column" is usually answered by deriving it instead.

- **No attendance columns.** No present/absent count, no percentage, no last-seen
  date, no status. Attendance is computed per event from the current master
  list, so storing it would only ever be a stale copy. Uploading scans is the
  only thing that marks someone present; everyone else in scope is absent.
- **No `machine_id`, `source_id`, `person_code` or `programme`.** The number the
  machine prints is not its own field. For a student it is the last part of the
  matric number, and for staff it is the digits in the staff number, so both are
  derived (`studentScanNumberSql()`, `staffScanNumberSql()` in
  `src/server/masters.ts`). The file's `id` column is the machine's own
  numbering and is not kept at all: for students it repeats the matric number,
  and for staff the machine uses the staff number instead.
- **No `department_id`, no `departments` table.** A student's department comes
  from the matric number (`VUG/CSC/...` → `CSC`, `VPG/PGD/ECO/...` → `ECO`).
  `studentDepartmentSql()` and `studentCategorySql()` in `src/server/masters.ts`
  do this, so the derived values are available everywhere a query runs without
  being stored. Adding a department table means maintaining it by hand.
  `student_event_departments` and `schedule_departments` are **not** such a
  table: they record which departments an _event_ was run for, one row per
  selection, and say nothing about any person.
- **No `deleted_at` or `status`.** Removing someone from the master list is done
  by re-uploading a file without them, or by `DELETE`, so the list stays
  whatever the file says.
- **No `normalized_name`.** Name matching normalises on the fly
  (`normalizeName()` in `src/lib/attendance.ts`).

Staff have no level and no undergraduate/postgraduate split, because nothing in
their file implies one. They do have a department: the first non-empty of
`admin_department` and `department` (`staffDepartmentSql()` in
`src/server/masters.ts`). An event covering several departments stores one row
per department in a junction table, and its expected count is the size of the
union of those departments, so picking two departments never double-counts
anyone. A staff event naming no department expects everyone.

The four staff with neither column have no department to be selected by. They
are expected at an event that names no department, and excluded from one that
does, and a picker cannot offer them because there is no name to offer.

Natural keys differ by file, and that is not an inconsistency: students key on
`matric_no` (always present), staff on `staff_no`, which is the one identifier
their file supplies. The two staff rows whose `staff_no` is the literal text
`NULL` have no key; they are matched on name on re-upload rather than
duplicated, and a MySQL unique key lets several NULLs through anyway.

## Scan matching

Matching is exact on purpose. The scan's number is compared to the derived
number with `===` semantics — `149111` and `14911` are different people. Do not
add fuzzy or substring matching, and do not pad or strip digits to make things
line up.

Three things the real data needs, all in `src/server/events.ts`:

- **Leading zeros.** `SA 063` and `JT 067` are written with a zero the machine
  does not print, so both spellings are indexed and looked up. This is not
  fuzzy matching; it is the same number written two ways.
- **Colliding staff numbers.** 64 staff numbers are shared by more than one row.
  The machine's name picks between them, and the app refuses when it cannot.
- **An inconsistent name column.** The machine prints a different subset and
  order of name parts for different people (`LNAME FNAME`, `LNAME MNAME`,
  `FNAME LNAME`). A person is therefore indexed under their full name _and_
  their surname-and-first-name; either agreeing counts. `normalizeName()` sorts
  the words, so order does not matter.

Do not weaken these to raise the match rate. A wrong "present" is worse than an
unresolved scan: unresolved scans belong in the unmatched list, where a human
can see them and look them up by hand. The registrar's own files contain real
conflicts — one person listed twice under `SA1319-` and `SA1319`, and two
different people sharing `AT 1030` — and those are data problems to fix in the
file, not in the code.

`match_method` in the scan tables is `number`, `name` or `none`. `number` means
the derived number matched. `name` means the number was unknown and a unique name
matched. `none` means it is in the unmatched list.
