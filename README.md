# Attendance Register

Student and staff attendance register. Runs entirely on this machine — no cloud, no external services. A local SQLite database, a TanStack Start server, and an Electron desktop shell. Sync across multiple computers via a shared MariaDB hub (optional, configured entirely from the UI).

## Quick Start (Desktop App)

### Windows Installer
1. Download `Attendance Register Setup 1.3.0.exe` (or the portable `.exe`)
2. Run the installer — no admin rights needed for portable, admin for system install
3. Launch **Attendance Register** from Start Menu or Desktop
4. First launch creates your local database automatically
5. Open the app → **Create Account** → first account becomes **Administrator**

### Web Version (test on a copy of your real data)
Double-click **`start-web.cmd`** in the project folder (or run it from a terminal). It:
1. copies the desktop app's database (`%APPDATA%\attendance-register\database`) to `db\web\attendance.db` the first time; the desktop app's own database is never written to;
2. builds the latest code and starts the web version at **http://127.0.0.1:3000**, opening it in your browser.

Sign in with your usual account. Run `start-web.cmd fresh` (with the desktop app closed) to take a new copy of the real data. Press Ctrl+C in the window to stop.

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
- Leave **This file is the complete, current staff list** ticked when the file is the registrar's full `staffdb.xlsx`: anyone not in it is kept (old scans still count for them) but is no longer expected anywhere, so stale records never show as absent.
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
   You can choose **several files at once**. A row that is already stored (same number, name and time) is skipped, so uploading the same export again, or a later export that repeats earlier rows, only adds what is new. The message says how many rows were added and how many were already there.
4. If the app is not certain about some scans, a **Confirm the matches** window opens (see *Confirming uncertain matches* below). Reports and downloads stay locked until it is answered.
5. Review **Unmatched** tab → fix machine IDs or names if needed
5. **Reset** a participant type if you need to re-upload

### Viewing Reports
- **Weekly Mass**: the report is right under the uploads on the week's page, with the same per-person results and the downloads (CSV, Excel, PDF). A staff week shows staff, a student week shows students, and a week with both asks which one (and switches to the group you just uploaded).
- **Search and filters** on every report table: search by name (any word order) or number (`SA 39`, `sa39` and `39` find SA39 but not SA393; `15336` finds VUG/PCS/25/15336), and filter by department/unit, weekday and level where the table has them. Tab counts show "12 of 509" while a filter is on.
- **Students** are matched by matric/machine number (every number is unique), so student uploads never ask you to confirm or merge. A mistyped number with a name that only one student has still counts for that student. When the printed name has nothing in common with the number's owner and is clearly another student's name (`14897 MASUOMO EBIMIL` is Amasuomo Ebimi Lewisa, 14890), the name decides.
- **Undergraduates or postgraduates**: when a Weekly Mass week covers students, you choose who is expected — Undergraduates (VUG…), Postgraduates (VPG…) or both. Only those students are expected, counted absent and charged on the debt page. It can be changed until the first student file is uploaded.
- **Student files per level**: pick every level the file holds when you upload (one file can be for several, e.g. 500 and 600 for `5-600LVL PROCESSED.xlsx`). The week's report covers only the levels uploaded so far (a level whose file is not in yet is not shown absent), and the report under the upload switches to the level you just uploaded. A student who scanned in any of the week's files is present, whichever level's file it was (the 300L file often holds 100L and 200L students); you are told when a file holds other levels.
- **Importing the student list** (`Main_updated.csv`): tick "complete, current student list" and students not in the file (graduated, withdrawn) stop being expected and charged; they stay on record and still match a scan. A file that repeats a column name (two `level` columns) keeps the first filled one. Departments renamed by the file ("Nursing" → "Nursing Sciences") keep their Mass weekday. Departments are matched to weekdays ignoring capitals.
- **Import summary**: only what changed is written. Each import says, for example, "The file has 200 staff: 70 added, 2 updated, 128 already up to date."
- **Event** → **Open reports** → Present / Absent / Late / Out of Scope
- **Reports** page → filter by date range, department, category
- **Download CSV** for Excel/records

### Managing People
- **Students / Staff** pages → search, sort, edit
- **Edit** button → fix names, department, faculty, machine ID
- **Machine ID** column shows the scanner's ID (from registrar file)
- **Sync Weekdays** (Staff page) → refresh department→weekday assignments

---

## Sync computers (several computers in one office)

Nothing to install but the desktop app. All computers must be on the same office network (cable or Wi-Fi).

**Once, on the computer that is usually on (the Main computer):**
1. Sign in as an administrator → **Sync computers** (in the menu) → **Make this the Main computer**.
2. A 6-digit **pairing code** is shown. If Windows asks whether Attendance Register may use the network, choose **Allow** (private networks).

**On each other computer:**
1. Sign in as an administrator → **Sync computers** → **Find the Main computer**. It appears by name; choose it.
2. Type the 6-digit code → **Connect**. The first sync starts at once (a minute or two for a full staff and student list).

**After that:** every computer keeps its own full copy and works even when the Main computer is off. Each one exchanges its changes with Main **by itself every 3 minutes**, and **Synchronize now** does it at once. The menu shows "Synced 2 min ago" (or that Main cannot be reached).

What is shared: users, staff and student lists, always-present staff, student and staff events with their uploads and scans, recurring events, **Weekly Mass** (weeks, weekdays, department days, uploads, scans, expected lists), answers in **Confirm the matches**, and the **debt rates** — so the debt page is the same on every computer. Edits and deletions are shared too. The same person entered on two computers (same staff number / matric number / email) is recognised as one person.

Good practice: connect the computers before the work starts. A computer that joins with data of its own sends that data to Main as new (an old copy can bring back something that was deleted elsewhere since).

### Advanced: MariaDB hub (optional)
For offices that run their own MariaDB server: **Admin Settings → Advanced: MariaDB hub synchronization**.



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

### Mass Debts (Weekly Mass → Mass debts)
- Every absence from a Weekly Mass is charged: **staff ₦10,000, students ₦5,000** (an administrator can change the rates on the page).
- A week counts once a machine file has been uploaded to it. Student files uploaded for one level ("Level 200") charge only that level until the other levels' files are in.
- Nothing is stored per person: the debts are worked out from the weeks' results every time, so a confirmed match, a merged duplicate, a re-upload or a change to the always-present list changes the debts straight away. Weeks still waiting for matches to be confirmed are marked provisional.
- Views: totals, **each person owing** (search by name/number, filter by department), **by department/unit**, **by week**, **by month**; pick a month and staff/students at the top. Each view downloads as Excel, CSV or PDF.

### Always-present staff (People → Always-present staff)
- Staff such as the Vice-Chancellor, DVCs, Provost or Registrar can be added by an administrator (search by name or staff number, give the office).
- They are shown **present** ("Always present") at every staff event that concerns them and every staff Weekly Mass that has an upload, never absent, and never charged on the debt page.
- Removing someone puts them back on the ordinary rules, for past weeks too.

### Importing master lists into running weeks
- People added by a staff or student import are added to the expected list of weeks that are already running (nobody already expected is removed or changed), and unmatched scans are matched again. So importing the complete student list after a week was created turns their "unmatched" scans into present.

### Department Weekdays (Community Mass)
- **Mass → Weekdays** → assign each department to Mon–Fri
- **Sync Weekdays** button → auto-adds new departments from staff list
- A department with no weekday = never expected at weekday Mass

### One Person, One Identity (no one is both present and absent)
Two staff records are joined into one person **only when the staff number is the same**, apart from spaces and capitals (`AT1430` = `AT 1430` = `at1430`). Students: the same matric number.
- **Never joined automatically**: different staff numbers, however alike the names (`SA 534` / `SAC534`, twins such as AKWUTE Sylvester / Sylvia), and the same machine number with different names (the machine prints `39` for two different staff). When two such records look like one person on the present and absent lists, an administrator is asked once (see Look-alikes below).
- Every count is per person: Weekly Mass, event pages, the daily/weekly/monthly reports and the Excel/CSV downloads. A person is exactly one of present, absent or out of scope, never two. Older weeks are read the same way, with no re-upload needed.
- Students: matric numbers that differ only in case, spacing, punctuation or leading zeros (`vug/csc/25/01001` = `VUG/CSC/25/1001`) are one student.
- Duplicates are removed automatically after **every staff import, every student import and every Synchronize**. Uploading the same scan file twice never changes who is present.
- **Who scanned (staff)**: the number only narrows the field; the **printed name decides**.
  1. An answer an admin gave before.
  2. Everyone with that machine ID / staff-number digits whose name fits the printed name — full name, a name the machine cut short (`IKPEAMA CHILO`), an initial or a spelling variant. Two different people who share one machine number are each matched by their own name, so both are present. People on the current staff list come first.
  3. Nobody with that number has that name: the person whose name it clearly is (2+ words, full or cut short), current staff first (`1548 IGWE CHICHI` is IGWE CHICHI, AT1508).
  4. Nobody has that name, but the number's owner shares part of it (a typo `MWOKORIE` for NWOKORIE, a married name `ODU JANE` for Anyanwu Jane): the number's owner.
  5. Otherwise the scan is **not guessed**: it goes to the **Confirm the matches** window.
- When the matching rules improve, every stored scan is matched again once with the new rules (your answers are kept), so older weeks are corrected without re-uploading.

### Closing a week or event (stop counting)
- When you have finished uploading, press **Close week — stop counting** (Weekly Mass) or **Close — stop counting** (events). Who was expected and who was present are kept exactly as they are; staff or students added to the list later are never counted in it, scans are not matched again, and no files can be added. **Reopen** undoes it.
- Even while open, someone added to the staff or student list **after** the last file was uploaded is never counted absent there. If they did scan (and were unmatched because they were not on the list yet), they become present.
- Weekly Mass weeks marked *Completed* or *Archived* are closed.

### Unmatched
"Unmatched" counts the different entries the machine printed that are nobody on the list — one per number + name, however many times it was scanned and in however many files (`039 ADA OKO` and `39 Ada Oko` are one entry). The card, the Unmatched tab, the per-file table and the downloads all show this same number. The per-file table shows each file's numbers as they are now.

### Accounts
- Every installation has two administrator accounts, created the first time the app starts if they are not there yet: `bassan@veritas.edu.ng` and `tapiyadi@veritas.edu.ng`, password `welcome@123`. **Change these passwords after the first sign-in** (My account, at the bottom of the menu). An account that already exists is never reset.
- **My account** (everyone): change your name, sign-in email or password; your current password is asked for before the email or password changes.
- **Users & Permissions** (admins): change anyone's role, name, email or password (Edit), or delete an account. Nobody can delete their own account or remove their own admin role.
- **Staff** (admins): the bin button deletes a member of staff; their scans stay but match nobody, and they are no longer expected in open weeks and events.

### Confirming uncertain matches (before any report)
After an upload, Weekly Mass and event pages show an amber **Confirm before reporting** banner (button **Review now**), and the window opens by itself for editors. It has two kinds of questions:
- **Scans the app is unsure about**: pick the right person from the suggestions, search for someone else, or say it is nobody on the list. The answer is remembered, so the same scan never asks again on later uploads.
- **Answers given before** (bottom of the window, or **Saved match answers** on the page): every answer can be taken back with **Undo**, and its scans are matched again. An answer of "not anyone on the list" whose printed name matches someone exactly is flagged in amber, because that person is then shown absent.
- **Look-alikes**: someone counted present who is almost certainly the same as someone counted absent — every word of the shorter name is in the other name (`Boyi Solomon` A600 / `BOYI SOLOMON SYLVESTER` AT 600). Answer **Different people** (never asked again; choose this when unsure) or **Same person — merge** (the records become one and the person is present).
Report generation, CSV downloads and the Reports page refuse to produce a report for that week/event until nothing is left to confirm.

### Merging Duplicate Staff
- **Staff import** updates existing people instead of adding them again (by the same staff number, spaces and capitals aside) and reads the registrar's `staffdb.xlsx` layout (`Staff Number`, `Surname`, `OtherNames`, `Staff_ID_on_machine`, ...). After every staff import, records with the same staff number are merged automatically. Re-importing `staffdb.xlsx` with **complete list** ticked restores anyone an earlier version merged by mistake.
- **Admin → Staff Deduplication**: *Scan* shows what would be merged and a **Check by hand** list of look-alikes that are never merged automatically; *Merge* folds duplicates into one record and moves their scans.
- Deletes don't sync, so merge on every computer that has the duplicates (results are correct either way).

### Recurring Templates
- **Recurring** → create weekly patterns (e.g., "Monday Chapel")
- Generates concrete events for a date range
- Edits to template regenerate future events

### Data Export / Backup
- **Events / Reports** → **Download CSV** (per event or bulk)
- **Admin → Clear staff** — the staff list and all staff attendance (staff events, staff Weekly Mass, always-present list); students stay
- **Admin → Clear students** — the student list and all student attendance; staff stay
- **Admin → Clear events** — student and staff events with their files and scans; people and Weekly Mass stay
- **Admin → Clear Weekly Mass** — every Mass week with its files, scans and expected lists; people and events stay
- **Admin → Clear all data** — everything except user accounts (the audit log, department weekdays and debt rates are always kept)
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