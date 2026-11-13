import type { PersonType, StudentCategory } from "@/lib/attendance";

export type { PersonType, StudentCategory };

export type AppRole = "admin" | "operator" | "viewer";

export type SessionUser = {
  id: string;
  email: string;
  fullName: string | null;
};

/** Who is signed in, and what they may do. Returned by GET /api/auth/me. */
export type Me = {
  user: SessionUser;
  roles: AppRole[];
};

/**
 * Whether this server has a Windows installer to offer. A packaged desktop build
 * does not, because shipping a 114 MB installer inside the installer made no
 * sense, so the landing page hides the download when this is false.
 */
export type DesktopRelease = {
  available: boolean;
  fileName: string | null;
  sizeBytes: number | null;
};

// Master lists ------------------------------------------------------------

/**
 * A student as the app shows them. The category and the department code are not
 * stored on the person: they are read out of the matric number when the row is
 * loaded. `department` is the full name the registrar's file spelled out ("Computer
 * Engineering"), kept for display; `marital_status` is from the same file and is
 * null when the file had none.
 */
export type Student = {
  id: string;
  matric_no: string;
  full_name: string;
  /** The name parts, so a correction can be made on one of them. */
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  student_category: StudentCategory | null;
  level: string | null;
  department_code: string | null;
  /** The department name as the file spells it, when the file had one. */
  department: string | null;
  /** From the registrar's file; null when the file had none. */
  marital_status: string | null;
};

export type Staff = {
  id: string;
  staff_no: string | null;
  full_name: string;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  faculty: string | null;
  department: string | null;
  admin_department: string | null;
  machine_id: string | null;
};

export type StudentList = {
  students: Student[];
  total: number;
  levels: string[];
  departments: string[];
  undergraduate: number;
  postgraduate: number;
};

export type StaffList = {
  staff: Staff[];
  total: number;
  withStaffNo: number;
};

/** Filters shared by the list pages, the events and the reports. */
export type StudentScope = {
  category?: StudentCategory | null;
  level?: string | null;
  /** Single department, kept for the list pages and older callers. */
  departmentCode?: string | null;
  /**
   * Every department in scope. An event can name several, so this is the field
   * that decides who is expected; `departmentCode` narrows a browsable list to
   * one.
   */
  departmentCodes?: string[] | null;
};

/**
 * Staff carry no level and no undergraduate/postgraduate split, so a department
 * list is the only narrowing that can be stated truthfully. A staff department is
 * the admin department, falling back to the department they sit in.
 */
export type StaffScope = {
  departments?: string[] | null;
};

export type StudentListQuery = StudentScope & {
  search: string;
  limit: number;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
};

export type StaffListQuery = {
  search: string;
  limit: number;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
};

// Imports -----------------------------------------------------------------

export type ImportResult = {
  saved: number;
  skipped: number;
};

// Events ------------------------------------------------------------------

export type GroupKind = "student" | "staff";

/**
 * One staff department offered by a picker, with the number of staff in it, so
 * a department can be seen to include somebody before an event is scoped to it.
 */
export type StaffDepartmentOption = {
  department: string;
  total: number;
};

/** The scope an event covers. Absent means "everyone", not "nobody". */
export type EventScope = StudentScope;

/**
 * What kind of event this is, so a report or the dashboard can be narrowed to
 * the Community Mass and leave the rest out. Stored on the event rather than
 * read off the title: renaming an event must not move it between categories.
 */
export type EventCategory = "community_mass" | "other";

export const EVENT_CATEGORY_LABEL: Record<EventCategory, string> = {
  community_mass: "Community Mass",
  other: "Other Events",
};

export type StudentEvent = {
  id: string;
  title: string;
  event_date: string;
  event_category: EventCategory;
  start_time: string | null;
  end_time: string | null;
  category: StudentCategory | null;
  level: string | null;
  /** First department in scope, for labels and older readers. */
  department_code: string | null;
  /** Every department in scope. Empty means every student. */
  departments: string[];
  notes: string | null;
  status: "draft" | "finalized";
  created_at: string;
};

export type StaffEvent = {
  id: string;
  title: string;
  event_date: string;
  event_category: EventCategory;
  start_time: string | null;
  end_time: string | null;
  /** Every staff department in scope. Empty means every member of staff. */
  departments: string[];
  notes: string | null;
  status: "draft" | "finalized";
  created_at: string;
};

export type EventUpload = {
  id: string;
  file_name: string;
  label: string | null;
  row_count: number;
  present_count: number;
  out_of_scope_count: number;
  unmatched_count: number;
  uploaded_at: string;
  uploaded_by: string | null;
};

/** present + out_of_scope + unmatched always adds up to expected. */
export type EventSummary = {
  event: StudentEvent | StaffEvent;
  uploads: number;
  scans: number;
  expected: number;
  present: number;
  absent: number;
  outOfScope: number;
  unmatched: number;
  percent: number | null;
  firstScanAt: string | null;
  lastScanAt: string | null;
};

export type PresentRow = {
  person_id: string;
  name: string;
  code: string;
  level: string | null;
  department_code: string | null;
  category: StudentCategory | null;
  scan_count: number;
  first_scan_at: string;
  last_scan_at: string;
};

export type AbsentRow = {
  person_id: string;
  name: string;
  code: string;
  level: string | null;
  department_code: string | null;
  category: StudentCategory | null;
};

export type OutOfScopeRow = {
  person_id: string;
  name: string;
  code: string;
  level: string | null;
  department_code: string | null;
  category: StudentCategory | null;
  scan_count: number;
};

export type UnmatchedRow = {
  scan_id: string;
  scan_number: string | null;
  scanned_name: string | null;
  scan_count: number;
  first_scan_at: string;
  last_scan_at: string;
};

export type EventResult = EventSummary & {
  presentList: PresentRow[];
  absentList: AbsentRow[];
  outOfScopeList: OutOfScopeRow[];
  unmatchedList: UnmatchedRow[];
  uploadList: EventUpload[];
  /**
   * True when at least one person in presentList is credited present by the
   * override list rather than by a scan. Their scan_count is 0 and their scan
   * times are empty. The UI shows this as a note, so a reader of the event page
   * is told the present count includes people who did not scan.
   */
  hasGrantedPresence: boolean;
};

export type ScanUploadInput = {
  label?: string | null;
  fileName: string;
  rows: Array<{
    scanNumber: string | null;
    name: string | null;
    scannedAt: string | null;
    machineId: string | null;
  }>;
};

// Reports -----------------------------------------------------------------

export type ReportPeriod = "daily" | "weekly" | "monthly";
export type ReportGroupBy = "none" | "department" | "level" | "category";

export type ReportQuery = {
  period: ReportPeriod;
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  eventId?: string | null;
  detail?: ReportDetail;
} & StudentScope;

export type ReportBucket = {
  key: string;
  label: string;
  events: number;
  expected: number;
  present: number;
  absent: number;
  out_of_scope: number;
  unmatched: number;
  percent: number | null;
};

export type ReportSeries = {
  period: ReportPeriod;
  from: string;
  to: string;
  /** true when the buckets are a department/level/category split, not dates. */
  grouped: boolean;
  totals: {
    events: number;
    expected: number;
    present: number;
    absent: number;
    out_of_scope: number;
    unmatched: number;
    percent: number | null;
  };
  buckets: ReportBucket[];
  composition: Array<{ key: string; label: string; value: number }>;
  levels: string[];
  departments: string[];
  categories: Array<{ key: string; label: string; value: number }>;
};

export type ReportDetail = "summary" | "present" | "absent" | "all";

export type StaffReportQuery = {
  period: ReportPeriod;
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  /** One staff department name, or null for the whole staff list. */
  department?: string | null;
  eventId?: string | null;
  detail?: ReportDetail;
};

export type Dashboard = {
  students: number;
  undergraduates: number;
  postgraduates: number;
  staff: number;
  studentEvents: number;
  staffEvents: number;
  studentCommunityMassEvents: number;
  studentOtherEvents: number;
  staffCommunityMassEvents: number;
  staffOtherEvents: number;
  recentStudentEvents: Array<{ id: string; title: string; event_date: string; status: string }>;
  recentStaffEvents: Array<{ id: string; title: string; event_date: string; status: string }>;
};

export type AppUser = {
  id: string;
  email: string;
  fullName: string | null;
  roles: AppRole[];
  createdAt: string;
};

// Recurring events --------------------------------------------------------

export type RecurringTemplate = {
  id: string;
  name: string;
  description: string | null;
  /** Which master list the generated events are drawn from. */
  group_kind: GroupKind;
  /** Events generated from this template inherit it. */
  event_category: EventCategory;
  start_date: string;
  end_date: string;
  event_title_template: string;
  start_time: string | null;
  end_time: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type RecurringSchedule = {
  id: string;
  template_id: string;
  day_of_week: number; // 0=Sun, 1=Mon, ..., 6=Sat
  student_category: StudentCategory | null;
  level: string | null;
  /** Every department expected on this day. Empty means everyone. */
  departments: string[];
  title_suffix: string | null;
};

export type RecurringTemplateInput = {
  name: string;
  description?: string | null | undefined;
  group_kind?: GroupKind | undefined;
  event_category?: EventCategory | undefined;
  start_date: string;
  end_date: string;
  event_title_template: string;
  start_time?: string | null | undefined;
  end_time?: string | null | undefined;
  notes?: string | null | undefined;
  schedules: RecurringScheduleInput[];
};

export type RecurringScheduleInput = {
  day_of_week: number;
  student_category?: StudentCategory | null | undefined;
  level?: string | null | undefined;
  /** Several departments on one day. Empty or absent means everyone. */
  departments?: string[] | null | undefined;
  title_suffix?: string | null | undefined;
};

export type UpdateRecurringTemplateInput = {
  name?: string | undefined;
  description?: string | null | undefined;
  group_kind?: GroupKind | undefined;
  event_category?: EventCategory | undefined;
  start_date?: string | undefined;
  end_date?: string | undefined;
  event_title_template?: string | undefined;
  start_time?: string | null | undefined;
  end_time?: string | null | undefined;
  notes?: string | null | undefined;
  schedules?: RecurringScheduleInput[] | undefined;
};

export type RecurringTemplateWithSchedules = RecurringTemplate & {
  schedules: RecurringSchedule[];
};

export type GenerateEventsResult = {
  created: number;
  skipped: number;
  events: Array<{ id: string; title: string; event_date: string }>;
};

// Weekly Community Mass ------------------------------------------------------

/** Weekday Mass runs Monday to Friday. Sunday Mass is its own scope. */
export type MassScope = "weekday" | "sunday";

export type MassWeekStatus = "draft" | "active" | "completed" | "archived";

/** What reports a week is for. Uploads still name their own participant type. */
export type MassWeekParticipantType = "students" | "staff" | "both";

/** The participant type one upload was processed for. */
export type MassUploadParticipant = "student" | "staff";

/**
 * How a Mass report is broken down in an export. A department or weekday is
 * meaningful for both groups; level and category are student-only because the
 * staff master carries neither.
 */
export type MassReportGroupBy = "none" | "department" | "level" | "category" | "weekday";

export const MASS_REPORT_GROUP_OPTIONS: Record<
  MassUploadParticipant,
  Array<{ value: MassReportGroupBy; label: string }>
> = {
  student: [
    { value: "none", label: "No grouping" },
    { value: "department", label: "By department" },
    { value: "level", label: "By level" },
    { value: "category", label: "By category" },
    { value: "weekday", label: "By Mass weekday" },
  ],
  staff: [
    { value: "none", label: "No grouping" },
    { value: "department", label: "By department" },
    { value: "weekday", label: "By Mass weekday" },
  ],
};

/** 1=Monday .. 5=Friday, the JS getDay() convention. */
export const MASS_WEEKDAYS = [1, 2, 3, 4, 5] as const;

export const MASS_WEEKDAY_LABELS: Record<number, string> = {
  1: "Monday",
  2: "Tuesday",
  3: "Wednesday",
  4: "Thursday",
  5: "Friday",
};

export const MASS_STATUS_LABELS: Record<MassWeekStatus, string> = {
  draft: "Draft",
  active: "Active",
  completed: "Completed",
  archived: "Archived",
};

export type MassWeekdayAssignment = {
  id: string;
  department_code: string;
  day_of_week: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type MassWeek = {
  id: string;
  name: string;
  notes: string | null;
  scope: MassScope;
  participant_type: MassWeekParticipantType;
  status: MassWeekStatus;
  /** The weekdays selected for this week, sorted. Empty for Sunday scope. */
  weekdays: number[];
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

export type MassUpload = {
  id: string;
  mass_week_id: string;
  participant_type: MassUploadParticipant;
  level: string | null;
  file_name: string;
  label: string | null;
  row_count: number;
  present_count: number;
  out_of_scope_count: number;
  unmatched_count: number;
  uploaded_by: string | null;
  uploaded_at: string;
};

/** One expected person, from the frozen snapshot. */
export type MassExpectedRow = {
  person_id: string;
  person_no: string | null;
  full_name: string | null;
  level: string | null;
  department: string | null;
  day_of_week: number | null;
};

export type MassPresentRow = MassExpectedRow & {
  scan_count: number;
  first_scan_at: string;
  last_scan_at: string;
};

export type MassOutOfScopeRow = {
  person_id: string;
  person_no: string | null;
  full_name: string | null;
  level: string | null;
  department: string | null;
  scan_count: number;
};

export type MassUnmatchedRow = {
  scan_id: string;
  scan_number: string | null;
  scanned_name: string | null;
  scan_count: number;
  first_scan_at: string;
  last_scan_at: string;
};

export type MassSummary = {
  week: MassWeek;
  participant_type: MassUploadParticipant;
  level: string | null;
  expected: number;
  present: number;
  absent: number;
  out_of_scope: number;
  unmatched: number;
  /** Present as a percentage of expected, or null when nothing was expected. */
  percent: number | null;
  uploads: MassUpload[];
};

export type MassResult = MassSummary & {
  presentList: MassPresentRow[];
  absentList: MassExpectedRow[];
  outOfScopeList: MassOutOfScopeRow[];
  unmatchedList: MassUnmatchedRow[];
};

export type MassUploadInput = {
  participantType: MassUploadParticipant;
  level?: string | null;
  fileName: string;
  label?: string | null;
  rows: Array<{ scanNumber: string | null; name: string | null; scannedAt: string | null; machineId: string | null }>;
};
