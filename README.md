# Attendance Register

Student and staff attendance register. Runs entirely on this machine — no cloud, no external services. A local SQLite database, a TanStack Start server, and an Electron desktop shell. Sync across multiple computers via a shared MariaDB hub (optional, configured entirely from the UI).

## Quick Start (Desktop App)

### Windows Installer
1. Download `Attendance Register Setup 1.2.0.exe` (or the portable `.exe`)
2. Run the installer — no admin rights needed for portable, admin for system install
3. Launch **Attendance Register** from Start Menu or Desktop
4. First launch creates your local database automatically
5. Open the app → **Create Account** → first account becomes **Administrator**

### Development Mode
```bash
npm install
npm run db:migrate
npm run dev
```
Opens <http://127.0.0.1:3000> in your browser.

---

## Core Concepts

| Concept | Description |
|---------|-------------|
| **Master Lists** | Students & Staff — imported from registrar CSVs, never manually typed |
| **Events** | One-time attendance sessions (Student or Staff) with date, time, scope |
| **Weekly Mass** | Recurring Community Mass with department→weekday assignments |
| **Scans** | Machine exports (CSV/Excel) uploaded to an event; matched to people |
| **Sync** | Optional push/pull to a shared MariaDB hub (configured in UI) |

---

## Getting Started (Step by Step)

### 1. First Launch
1. Open the app → **Create Account**
2. Enter email, password, full name → **Sign Up**
3. First account = **Administrator** (can manage users, sync, import)
4. Subsequent accounts = **Viewer** (admin can promote later)

### 2. Import Master Lists (One-Time)
**Students:**
- Go to **Students** page → **Import the student list**
- Download template → fill `student_db.csv` (matric_no, names, level, department, marital_status)
- Upload → **Import**

**Staff:**
- Go to **Staff** page → **Import the staff list**
- Download template → fill `staff_db.xlsx` (Staff Number, Surname, OtherNames, Title, Gender, Designation, Department, Staff Category, Staff_ID_on_machine)
- Upload → **Import**
- **Sync Weekdays** button appears after import → click to auto-assign departments to Mass weekdays

### 3. Create Your First Event
**Student Event:**
- **Student Events** → **Create Event**
- Title, date, time, category (undergrad/postgrad), level, department(s)
- Save → **Active** status

**Staff Event:**
- **Staff Events** → **Create Event**
- Title, date, time, department(s) (optional — blank = all staff)
- Save → **Active**

**Weekly Community Mass:**
- **Mass** → **Weekdays** → assign each department to Mon–Fri
- **Mass** → **New Week** → name, date, scope (weekday/sunday), participant type
- Select weekdays → **Create**

---

## Daily Workflow

### Taking Attendance (Scan Upload)
1. Open the event → **Upload machine scans**
2. Choose **Students** or **Staff** file (must match event type)
2. Upload CSV/Excel export from the machine (columns: ID, NAME, Time)
3. Wait for processing → see **Present / Out of Scope / Unmatched** counts
4. Review **Unmatched** tab → fix machine IDs or names if needed
5. **Reset** a participant type if you need to re-upload

### Viewing Reports
- **Event** → **Open reports** → Present / Absent / Late / Out of Scope
- **Reports** page → filter by date range, department, category
- **Download CSV** for Excel/records

### Managing People
- **Students / Staff** pages → search, sort, edit
- **Edit** button → fix names, department, faculty, machine ID
- **Machine ID** column shows the scanner's ID (from registrar file)
- **Sync Weekdays** (Staff page) → refresh department→weekday assignments

---

## Synchronization (Multi-Computer)

### Prerequisites
- A MariaDB/MySQL server accessible on your LAN (e.g., one computer runs XAMPP MariaDB)
- Same database name on all machines

### Setup (Once Per Computer)
1. **Admin → Synchronization**
2. Fill in:
   - **Host**: IP of the MariaDB server (e.g., `192.168.1.50`)
   - **Port**: `3306` (default)
   - **User**: MariaDB user with create/read/write (e.g., `sync_user`)
   - **Password**: MariaDB password
   - **Database**: Name of the sync database (e.g., `attendance_sync`)
3. Click **Test Connection** → should show "Connection successful" (a failure is shown in red with the reason)
4. Click **Save Configuration** → shows "Configured" badge
4. Click **Synchronize Now** → pushes local changes, pulls remote changes

### How It Works
| Direction | What Happens |
|-----------|--------------|
| **Push** | Local edits (newer `updated_at`) → sent to hub |
| **Pull** | Hub changes (newer `updated_at`) → applied locally |
| **Conflicts** | Same timestamp, different content → reported, nothing overwritten |
| **Duplicates** | Same person, two IDs (created on different machines) → reported |
| **Scans** | Append-only by UUID — merge by missing ID |

**Run on each computer** after changes to keep all in sync. No auto-sync — manual button by design.

---

## User Roles

| Role | Permissions |
|------|-------------|
| **Admin** | Everything: users, sync, import, delete events, clear data |
| **Operator** | Create events, import master lists, upload scans, manage Mass |
| **Viewer** | Read-only: view events, reports, master lists |

Admin manages roles on **Permissions** page.

---

## Advanced Features

### Machine ID Matching
- Staff imports include **Machine ID** (from `Staff_ID_on_machine` column)
- Used for scan matching instead of deriving from staff number
- Falls back to staff number digits if Machine ID missing
- Edit any person's **Machine ID** on Staff page → fixes scan mismatches

### Department Weekdays (Community Mass)
- **Mass → Weekdays** → assign each department to Mon–Fri
- **Sync Weekdays** button → auto-adds new departments from staff list
- A department with no weekday = never expected at weekday Mass

### One Person, One Identity (no one is both present and absent)
A person can be on the master list twice, e.g. after a re-import wrote their staff number differently (`SA 534` then `SAC534`). The app treats such rows as **one person** everywhere:
- **Same person** = same name (surname + first name, any order/case) **and** the same staff-number digits (`SA 534` = `SAC534`, `08` = `A8`) or the same machine number. Students: the same matric number.
- **Not the same person**: same name with different numbers, or the same machine number with different names (the machine prints `39` for two different staff).
- Every count is per person: Weekly Mass, event pages, the daily/weekly/monthly reports and the Excel/CSV downloads. A person is exactly one of present, absent or out of scope, never two. Older weeks are read the same way, with no re-upload needed.
- Students: matric numbers that differ only in case, spacing, punctuation or leading zeros (`vug/csc/25/01001` = `VUG/CSC/25/1001`) are one student.
- Duplicates are removed automatically after **every staff import, every student import and every Synchronize**. Uploading the same scan file twice never changes who is present.
- Scan matching tries machine number, then scan number (the name settles a number shared by several people, including names the machine cut short, e.g. `ANOMU` for `ANOMUOGHARAN`, or `P` for `PRINCESS`), then exact name, then a strict close-name match. A scan that fits two people, or nobody, is left **Unmatched** for you to review rather than guessed.

### Merging Duplicate Staff
- **Staff import** updates existing people instead of adding them again (it recognises `SA 534` and `SAC534` as the same person) and reads the registrar's `staffdb.xlsx` layout (`Staff Number`, `Surname`, `OtherNames`, `Staff_ID_on_machine`, ...). After every staff import, records that are certainly the same person are merged automatically.
- **Admin → Staff Deduplication**: *Scan* shows what would be merged and a **Check by hand** list of look-alikes that are never merged automatically; *Merge* folds duplicates into one record and moves their scans.
- Deletes don't sync, so merge on every computer that has the duplicates (results are correct either way).

### Recurring Templates
- **Recurring** → create weekly patterns (e.g., "Monday Chapel")
- Generates concrete events for a date range
- Edits to template regenerate future events

### Data Export / Backup
- **Events / Reports** → **Download CSV** (per event or bulk)
- **Admin → Clear Events Only** — removes scans/events, keeps people
- **Admin → Clear All Data** — wipes everything except users
- **Sync** pushes/pulls all data including scans

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Could not load" on startup | Check `desktop.log` in `%APPDATA%\attendance-register\` |
| Sync fails | Test Connection first; check MariaDB running, firewall, credentials |
| Scans unmatched | Check Machine ID on Staff page; fix Machine ID or name. Close-but-not-exact names are only matched when one person is a clear winner |
| Database upgrade went wrong | Close the app, copy the newest file from `database\backups\` over `database\attendance.db` |
| Out of scope staff | Click **Sync Weekdays** on Staff page; department missing from weekdays |
| Sync password lost after editing settings | Fixed in this version: leaving the password box blank now keeps the saved password |
| Can't sign in | Dev: check `SESSION_SECRET` (32+ chars) in `.env`. Packaged: the secret is generated once and kept in `%APPDATA%\attendance-register\desktop.json`; `sync.env` cannot change it |
| "Not configured" on Sync | Configure hub in Admin → Synchronization first |

### Logs & Data Location
| File | Location |
|------|----------|
| Database | `%APPDATA%\attendance-register\database\attendance.db` |
| Sync config | `%APPDATA%\attendance-register\sync.env` |
| Logs | `%APPDATA%\attendance-register\desktop.log` |
| Backups | `%APPDATA%\attendance-register\database\backups\` (made automatically before each database upgrade; newest 10 kept) |

---

## Developer Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Dev server with hot reload |
| `npm run build` | Production build (`.output/`) |
| `npm run build:electron` | Bundle Electron main/preload |
| `npm run electron:dev` | Run dev Electron app |
| `npm run electron:build` | Build installer (`.exe`) |
| `npm run db:migrate` | Apply SQLite migrations |
| `npm run db:verify` | Run SQLite verification tests |
| `npm run typecheck` | TypeScript + Electron typecheck |
| `npm run lint` | ESLint |
| `npm run format` | Prettier write |

---

## File Structure (Key Folders)

```
src/
├── routes/           # Pages (TanStack Router)
│   ├── _authenticated/
│   │   ├── admin.tsx          # Admin: sync, users, clear data
│   │   ├── staff.tsx          # Staff master list, import, sync weekdays
│   │   ├── students.tsx       # Student master list, import
│   │   ├── mass/              # Weekly Mass: weeks, weekdays, reports
│   │   ├── student-events/    # Student events CRUD
│   │   └── staff-events/      # Staff events CRUD
│   └── api/             # JSON API endpoints
├── server/              # Server-only code
│   ├── sync.ts          # Hub sync engine (push/pull/conflicts)
│   ├── masters.ts       # Import/export/match logic
│   ├── events.ts        # Scan upload/matching
│   ├── mass.ts          # Weekly Mass logic
│   └── db.ts            # SQLite pool, migrations, transactions
├── lib/                 # Shared types, API client, utils
├── components/          # Reusable UI (tables, dialogs, forms)
└── lib/types.ts         # Core TypeScript types

db/
├── migrations/          # SQLite migrations (001-014), numbered by file name
├── schema.sql           # MySQL hub schema (for sync)
└── seed/attendance.db   # Bundled seed DB (shipped in installer)

electron/
├── main.ts              # Desktop entry: server + window + sync.env
├── preload.ts           # Secure IPC bridge
├── config.ts            # Desktop config (session secret)
└── updater.ts           # Auto-update from hub
```

---

## Security Notes

- **Local-first**: Database never leaves your machine unless you Sync
- **Loopback only**: Server binds to `127.0.0.1` — no external access
- **Sessions**: JWT in `httpOnly` cookie, signed with `SESSION_SECRET`
- **Passwords**: bcrypt hashed, never logged
- **Sync password**: AES-256-GCM encrypted in local DB
- **Roles**: Enforced on server, not just UI
- **No telemetry**: No analytics, no external calls

---

## License

MIT — see `LICENSE` file.

---

## Support

- Check `desktop.log` for errors
- Run `npm run db:verify` to validate schema
- Sync conflicts reported in Admin → Synchronization panel
- For issues, include `desktop.log` and MariaDB version