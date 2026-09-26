# Attendance Register

Student and staff attendance register. It runs entirely on this machine: a
TanStack Start Node server, a local MySQL/MariaDB database, and email/password
accounts. Nothing is sent to any hosted service.

## Requirements

- Node.js 22.12 or newer (`node -v`)
- A local MySQL or MariaDB server. XAMPP works: start MySQL from the XAMPP
  control panel, which listens on `127.0.0.1:3306` with user `root`.

## First-time setup

```
npm install
npm run db:migrate
npm run dev
```

Open <http://127.0.0.1:3000> and create the first account. The first account
created is the administrator; every account after it is a viewer, and an
administrator can change roles from the Users page.

## Everyday commands

| Command              | What it does                                              |
| -------------------- | --------------------------------------------------------- |
| `npm run dev`        | Development server on <http://127.0.0.1:3000>             |
| `npm run build`      | Production build into `.output/`                          |
| `npm start`          | Run the production build                                  |
| `npm run db:migrate` | Create the database and tables if they are missing        |
| `npm run db:reset`   | Drop everything and rebuild the schema (deletes all data) |
| `npm run typecheck`  | TypeScript check                                          |
| `npm run lint`       | ESLint + Prettier check                                   |
| `npm run format`     | Rewrite files with Prettier                               |

## Loading the registrar's files

The master lists are meant to be uploaded from the registrar's exports, either
through the Students or Staff page, or in bulk with the loader script. Start the
app first, then:

```
node scripts/load-master.mjs
```

It reads `student_db.csv` and `staff_db.csv` from the folder above the project
and posts them through the same import API the UI uses. Add `--with-scans` to
also check scan matching against `Machine_data.csv` / `Machine_data2.csv` in
throwaway events, which it deletes again afterwards.

`EMAIL`, `PASSWORD`, `PORT` and `BASE` override the defaults if needed.

## Configuration

Settings live in `.env` (copy `.env.example` to get started):

| Variable         | Default      | Meaning                                |
| ---------------- | ------------ | -------------------------------------- |
| `DB_HOST`        | `127.0.0.1`  | MySQL host                             |
| `DB_PORT`        | `3306`       | MySQL port                             |
| `DB_USER`        | `root`       | MySQL user                             |
| `DB_PASSWORD`    | empty        | MySQL password                         |
| `DB_NAME`        | `attendance` | Database name                          |
| `DB_POOL_SIZE`   | `10`         | Pooled connections                     |
| `SESSION_SECRET` | —            | Signs the login cookie, 32+ characters |
| `PORT`           | `3000`       | Server port                            |
| `HOST`           | `127.0.0.1`  | Bind address, loopback only by default |

Generate a session secret with:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Real environment variables override `.env`, so a packaged build can be
configured without a `.env` file.

## How it is put together

- `db/schema.sql` — the full schema, 12 tables. `db/migrate.mjs` applies it.
- `src/server/` — server-only code: MySQL pool, sessions, roles, imports.
- `src/routes/api/` — JSON API used by the UI. Every route requires a session.
- `src/routes/` — pages. Route tree is generated into `src/routeTree.gen.ts`.
- `src/lib/` — client data access and types shared with the server.

Sessions are JWTs in an `httpOnly` cookie, signed with `SESSION_SECRET`.
Passwords are hashed with bcrypt. Roles (`admin`, `operator`, `viewer`) are
enforced on the server, not in the UI.

## The master lists

`students` and `staff` hold the columns of the registrar's files and nothing
else. Students key on `matric_no`, which is always present. Staff key on
`staff_no`; the two rows whose `staff_no` is the literal text `NULL` are stored
without a key and are matched on name instead, because a unique key does not
count NULLs as equal.

Three things are worked out in SQL instead of being stored, which is why there is
no `departments` table and no category column:

| Stored column | Worked out                | Example                           |
| ------------- | ------------------------- | --------------------------------- |
| `matric_no`   | category                  | `VUG/CSC/18/2633` → undergraduate |
| `matric_no`   | department                | `VPG/PGD/ECO/15/1042` → `ECO`     |
| `matric_no`   | number the machine prints | the last part, `1042`             |
| `staff_no`    | number the machine prints | the digits, `SA 1188` → `1188`    |

Undergraduates put the department in the second part and postgraduates in the
third, after the award, so `PGD`, `M.A`, `M.Sc` and `PHD` are read as awards
rather than departments.

Attendance is calculated on request and never written onto a person. Expected
attendance for an event or report is the current master list for that event's
scope, so re-uploading a corrected file changes the numbers immediately.

## Matching scans to people

The machine prints a number, and in both files that number is already in a
column that is stored, so it is derived rather than kept as a second copy:

- a student's number is the last part of the matric number, `VPG/PGD/ECO/15/1042`
  → `1042`;
- a staff member's number is the digits in the staff number, `SAT979` → `979`,
  `AT 123` → `123`.

The scan's number is compared to that, exactly: `149111` and `14911` are
different people. Staff numbers that share their digits, and staff numbers
written with a leading zero while the machine prints it without one, are handled
without guessing.

Where two different people hold the same number, the machine's name picks
between them. The machine's `NAME` column is inconsistent about which parts of
the name it prints, so a person is remembered under both their full name and
their surname-and-first-name, and either agreeing is enough. If the name cannot
separate them the scan is reported as unmatched rather than attributed to the
wrong person.

A scan file can hold both students and staff, as `Machine_data.csv` does. Upload
it to the event for the list you are taking attendance for: a student event
resolves the student numbers and lists the staff ones as unmatched, and a staff
event does the reverse. Numbers are never carried into the wrong list.

Uploading a scan file is all that marks anyone present. Everyone else in the
event's scope is absent, because absence is just the absence of a scan.

## Notes

- The server binds to loopback, so it is only reachable from this machine.
- `.env` holds your database password and session key. Keep it out of git.
