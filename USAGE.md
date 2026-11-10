# Attendance Register — Complete Usage Guide

This guide walks through every feature of the desktop application with screenshots-level detail. Written for non-technical administrators and operators.

---

## Table of Contents
1. [Installation](#installation)
2. [First Run & Account Setup](#first-run--account-setup)
3. [Importing Master Lists](#importing-master-lists)
4. [Creating Events](#creating-events)
5. [Taking Attendance (Scan Upload)](#taking-attendance-scan-upload)
6. [Weekly Community Mass](#weekly-community-mass)
6. [Synchronization (Multi-Computer)](#synchronization-multi-computer)
7. [User Management](#user-management)
7. [Reports & Exports](#reports--exports)
8. [Troubleshooting](#troubleshooting)

---

## Installation

### System Requirements
- Windows 10/11 (64-bit)
- 4 GB RAM minimum, 8 GB recommended
- 500 MB free disk space
- MariaDB/MySQL server on LAN (for sync, optional)

### Install (System-wide)
1. Download `Attendance Register Setup 1.2.0.exe`
2. Run installer → follow prompts
3. Creates Start Menu entry + Desktop shortcut
4. Runs as current user (no admin needed after install)

### Portable Version
1. Download `Attendance-Register-portable-1.2.0.exe`
2. Place anywhere (USB drive, network share, folder)
3. Run directly — no installation, self-contained
4. Stores data in folder next to `.exe` (portable mode)

### First Launch
1. Double-click **Attendance Register** icon
2. Splash screen appears while local server starts (~10-15 seconds)
3. Window opens to **Sign In** page

---

## First Run & Account Setup

### Create First Account (Becomes Admin)
1. Click **Create Account**
2. Fill in:
   - **Email**: your work email
   - **Password**: strong password (12+ chars)
   - **Full Name**: your name as it appears on reports
3. Click **Sign Up**
4. You are now **Administrator** — only account that can:
   - Manage users & roles
   - Configure synchronization
   - Import master lists
   - Clear data

### Add More Users
1. Sign in as Admin → **Admin → Permissions**
2. New users sign up normally (Create Account)
4. Admin changes their role on **Permissions** page:
   - **Admin**: Full access
   - **Operator**: Create events, import, scan, Mass
   - **Viewer**: Read-only

---

## Importing Master Lists

### Prepare Your Files
**Students CSV** (`student_db.csv`):
```csv
matric_no,last_name,first_name,middle_name,level,department,marital_status
VUG/CSC/18/1234,Smith,John,Michael,300,Computer Science,Single
VPG/ENG/20/5678,Jones,Mary,Ann,500,Electrical Engineering,Married
```

**Staff Excel** (`staff_db.xlsx`):
| Staff Number | Surname | OtherNames | Title | Gender | Designation | Department | Staff Category | Staff_ID_on_machine |
|--------------|---------|------------|-------|--------|-------------|------------|----------------|---------------------|
| AT1430       | ODOALA  | FINIAN KELECHI | Dr.   | Male   | Senior Lecturer | Pharmaceutical Science | REGULAR | 1430 |

### Import Students
1. Go to **Students** page (sidebar)
2. Click **Import the student list**
3. Click **Download template** → open CSV → verify columns
4. Choose your `student_db.csv` → **Import**
5. Shows: `Imported X students. The master list is now up to date.`

### Import Staff
1. Go to **Staff** page
2. Click **Import the staff list**
3. Download template → verify `Staff_ID_on_machine` column exists
3. Choose your `staff_db.xlsx` → **Import**
3. **Critical**: After import, click **Sync Weekdays** button (top right of Master list)
   - This assigns each department to a Mass weekday (Mon–Fri)
   - Required for Community Mass to work correctly

### Verify Import
- **Students page**: Shows count, searchable table
- **Staff page**: Shows count, Machine ID column visible
- Click any row → **Edit** to verify Machine ID, department, faculty

---

## Creating Events

### Student Event (One-Time)
1. **Student Events** → **Create Event**
2. Fill:
   - **Title**: e.g., "CSC 301 Lecture Attendance"
   - **Date**: `2026-01-15`
   - **Start/End Time**: `08:00` / `10:00`
   - **Category**: Undergraduate / Postgraduate
   - **Level**: `300` (or leave blank for all)
   - **Departments**: Select one or more (blank = all)
   - **Notes**: Optional
3. Click **Create** → event appears in list as **Draft**
4. Click event → **Set Active** when ready for attendance

### Staff Event (One-Time)
1. **Staff Events** → **Create Event**
2. Fill:
   - **Title**: e.g., "Staff Meeting January"
   - **Date**: `2026-01-20`
   - **Start/End Time**: `14:00` / `16:00`
   - **Departments**: Select specific depts (blank = all staff)
3. Create → **Set Active**

### Recurring Events (Templates)
1. **Recurring** → **Create Template**
2. Define weekly pattern (day, time, scope)
3. **Generate Events** → pick date range
4. Creates individual events you can edit separately

---

## Taking Attendance (Scan Upload)

### Prepare Machine File
Machine exports CSV/Excel with columns:
| ID | NAME | Time |
|----|------|------|
| 1234 | SMITH JOHN | 2026-01-15 08:05:12 |
| 5678 | JONES MARY | 2026-01-15 08:07:45 |

### Upload Scans
1. Open the **Active** event
2. Click **Choose student file** (or **Choose staff file**)
3. Select machine CSV/Excel
4. Optional: **Label** = "Morning clock-in"
5. Click **Upload**
5. Wait for progress bar → shows results:
   - **Rows**: total scanned
   - **In scope**: matched + in event scope
   - **Out of scope**: matched but not in event scope
   - **Unmatched**: no match found

### Fixing Unmatched Scans
1. Click **Unmatched** count → shows list
2. Common issues:
   - **Wrong Machine ID**: Edit person on Staff page → fix Machine ID
   - **Name mismatch**: Machine prints "SMITH JOHN" but master has "SMITH JOHN MICHAEL"
   - **Missing person**: Import missing person first
4. Fix → **Reset** the participant type → re-upload

### Reset (Re-upload)
- Click **Reset students** or **Reset staff** → confirms deletion of all scans for that type
- Re-upload corrected file

---

## Weekly Community Mass

### Setup Department Weekdays
1. **Mass → Weekdays**
2. Each department = one weekday (Mon=1, Tue=2, Wed=3, Thu=4, Fri=5)
3. Click **Sync Weekdays** (auto-fills from Staff departments)
3. Adjust manually if needed
4. **Active** toggle = include in Mass

### Create a Mass Week
1. **Mass → New Week**
2. Fill:
   - **Name**: "Week 3 Community Mass"
   - **Date**: `2026-02-15`
   - **Scope**: Weekday / Sunday
   - **Participants**: Students / Staff / Both
   - **Weekdays**: Mon/Tue/Wed/Thu/Fri (only for Weekday scope)
3. Create → **Set Active** when ready

### Mass Attendance
- Upload scans same as events
- **Weekday Mass**: expects only departments assigned to that day
- **Sunday Mass**: all undergraduates except `marital_status = 'Religious'`
- Reports show expected vs actual by department

---

## Synchronization (Multi-Computer)

### Prerequisites
- One MariaDB server on LAN (e.g., Computer A runs XAMPP MariaDB)
- All computers on same network (WiFi/Ethernet)
- MariaDB user with `CREATE`, `SELECT`, `INSERT`, `UPDATE`, `DELETE` on sync database

### Configure (Do Once Per Computer)
1. **Admin → Synchronization**
2. Fill:
   - **Host**: IP of MariaDB server (e.g., `192.168.1.50`)
   - **Port**: `3306`
   - **User**: `sync_user` (or your MariaDB user)
   - **Password**: MariaDB password
   - **Database**: `attendance_sync` (must exist on MariaDB)
3. Click **Test Connection** → "Connection successful"
4. Click **Save Configuration** → shows "Configured" badge
5. Click **Synchronize Now**

### Daily Sync Routine
1. Make changes (import, scans, edits)
2. Click **Synchronize Now** (Admin page)
3. Wait for: `Pushed X, Pulled Y, Conflicts Z`
4. Repeat on other computers

### Conflict Handling
| Conflict Type | What Happens |
|---------------|--------------|
| Same stamp, different data | Both keep their version; reported in sync result |
| Same person, two IDs | Both IDs kept; reported; fix manually on one machine |

---

## User Management

### Roles
| Role | Can Do |
|------|--------|
| **Admin** | Everything: users, sync, import, delete, clear data |
| **Operator** | Create events, import, upload scans, Mass |
| **Viewer** | View only |

### Change Role
1. **Admin → Permissions**
2. Find user → dropdown → select new role
3. Saves instantly

### Delete User (Admin Only)
1. **Permissions** page
2. Click **Delete** on row (not your own)
4. Confirm → permanently removes account

---

## Reports & Exports

### Event Reports
1. Open event → **Open reports**
2. Tabs:
   - **Present**: Scanned + in scope
   - **Absent**: Expected but no scan
   - **Out of Scope**: Scanned but not in scope
   - **Unmatched**: Could not match

### Bulk Reports
- **Reports → Student Reports / Staff Reports**
- Filter: date range, department, category, level
- **Download CSV** → Excel compatible

### Export All Data
- **Admin → Clear Events Only** → downloads CSV of all events first
- **Sync** → pushes all data to hub (backup)

---

## Troubleshooting

### App Won't Start
1. Check `%APPDATA%\attendance-register\desktop.log`
2. Common: port in use → restart computer
3. Corrupt DB → delete `attendance.db` (recreates from seed)

### Sync Fails
| Error | Fix |
|-------|-----|
| "Not configured" | Configure hub in Admin → Synchronization |
| "Connection refused" | MariaDB not running / wrong IP / firewall |
| "Access denied" | Wrong user/password / insufficient privileges |
| "Unknown database" | Create `attendance_sync` on MariaDB first |

### Scans Not Matching
| Symptom | Fix |
|---------|-----|
| All unmatched | Wrong participant type (student vs staff) |
| Some unmatched | Fix Machine ID on Staff page |
| "Out of scope" | Department missing from Weekdays; click Sync Weekdays |
| Name mismatch | Machine prints "SMITH JOHN" vs "SMITH JOHN MICHAEL" — edit name |

### Can't Sign In
- Dev: check `.env` has `SESSION_SECRET`
- Packaged: check `sync.env` has `SESSION_SECRET`
- Clear browser cookies / app data

### Logs Location
```
%APPDATA%\attendance-register\
├── database\attendance.db      # Main database
├── database\backups\           # Auto-backups before sync
├── sync.env                    # Sync credentials (legacy)
├── desktop.log                 # Startup/sync errors
└── config.json                 # Session secret, window state
```

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Ctrl+K` | Search (global) |
| `Enter` | Submit form / open row |
| `Esc` | Close dialog / cancel |
| `Tab` | Next field |
| `Shift+Tab` | Previous field |

---

## Data Backup Strategy

| Method | Frequency | What It Covers |
|--------|-----------|----------------|
| **Sync** | Daily | All data → hub (best) |
| **Auto-backup** | Before each sync | Local DB snapshot in `backups/` |
| **CSV Export** | Weekly | Reports only |
| **Manual copy** | Monthly | Copy `attendance.db` file |

---

## Uninstall
1. Windows Settings → Apps → Attendance Register → Uninstall
2. Removes app, keeps data in `%APPDATA%\attendance-register\`
3. To fully wipe: delete `%APPDATA%\attendance-register\` folder