# Attendance System Roadmap

## Core (in progress)
- [x] Database: people, departments, sessions, population snapshot, imports, import rows, attendance records, roles, audit
- [ ] Auth (email/password + Google) with admin/operator/viewer roles
- [ ] Import master students (student_db.csv) and staff (staff_db.csv)
- [ ] Session creation with expected population snapshot
- [ ] Excel/CSV upload from attendance machine + matching engine
- [ ] Matching key rule: students matched by numeric id; staff matched by digits extracted from staff_no (ignore letters)
- [ ] Results: present / absent / out_of_scope / unmatched, consolidating repeat scans
- [ ] Basic reports and exports

## Later
- [ ] Weekly/monthly/departmental reports, audit log UI, backups
