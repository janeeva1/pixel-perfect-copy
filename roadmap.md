# Attendance System Roadmap

## Done

- [x] Separate student and staff master lists holding only the registrar's
      file columns
- [x] Local email/password auth (bcrypt + signed httpOnly cookie) with
      admin/operator/viewer roles enforced on the server
- [x] Master import: CSV/Excel parsing and natural-key upserts
      (`matric_no` for students, `staff_no` for staff)
- [x] Machine upload: CSV/Excel parsing, match on the number the machine prints
      (derived from the matric tail or the staff-number digits, never stored),
      with name used only to separate genuinely colliding staff numbers
- [x] Student and staff events with uploads, drafts and finalising
- [x] Results per event: present / absent / out_of_scope / unmatched, with
      repeat scans consolidated
- [x] Daily, weekly and monthly reports, groupable by department, level or
      category, with CSV export
- [x] Audit log on every write

## Deliberately not stored

Attendance is calculated, never written onto a person. The master tables have no
attendance column, no status and no deleted flag, so "expected" always reflects
the current master list.

Also derived rather than stored: the undergraduate/postgraduate category and the
department, both read out of `matric_no` in SQL. That is why there is no
`departments` table and no `person_code`.

## Settled

- A mixed machine file is uploaded to the event for the list it is about.
  `Machine_data.csv` holds both student and staff ids, so a student event
  resolves the student ids and reports the staff ones as unmatched, and a staff
  event does the reverse. No id is ever guessed into the wrong list, which also
  settles the 8 ids that appear in both master lists: whichever event you upload
  to, that id is resolved for that list.

## Open

- [ ] Audit log UI
- [x] Automatic database backup before each schema upgrade
- [ ] Scheduled database backups
- [ ] Admin page for the staff duplicate preview/merge (API exists)
