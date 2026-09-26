import type {
  AppRole,
  AppUser,
  Dashboard,
  EventCategory,
  EventResult,
  EventSummary,
  EventUpload,
  GenerateEventsResult,
  ImportResult,
  Me,
  RecurringTemplate,
  RecurringTemplateInput,
  RecurringTemplateWithSchedules,
  ReportGroupBy,
  ReportPeriod,
  ReportSeries,
  ScanUploadInput,
  StaffEvent,
  StaffList,
  StudentCategory,
  StudentEvent,
  StudentList,
  StaffDepartmentOption,
  UpdateRecurringTemplateInput,
} from "@/lib/types";

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const initWithBody: RequestInit = init?.body
    ? { ...init, headers: { "content-type": "application/json", ...init.headers } }
    : { ...init };

  const response = await fetch(path, { ...initWithBody, credentials: "same-origin" });

  let payload: ({ error?: string } & T) | null = null;
  try {
    payload = (await response.json()) as ({ error?: string } & T) | null;
  } catch (e) {
    console.error("Failed to parse JSON response from", path, e);
  }
  if (!response.ok) {
    const errorMsg = payload?.error ?? `Request failed (${response.status}).`;
    console.error(`API ERROR [${response.status}] ${path}:`, errorMsg);
    throw new ApiError(response.status, errorMsg);
  }
  return payload as T;
}

async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
  const response = await fetch(path, { ...init, credentials: "same-origin" });
  if (!response.ok) {
    const errorMsg = await response.text().catch(() => `Request failed (${response.status}).`);
    throw new ApiError(response.status, errorMsg);
  }
  return response.blob();
}

function post<T>(path: string, body?: unknown): Promise<T> {
  return request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) });
}

function put<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: "PUT", body: JSON.stringify(body) });
}

function search(params: Record<string, string | number | null | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined && value !== "") query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

export type StudentListParams = {
  search?: string;
  category?: StudentCategory | null;
  level?: string | null;
  departmentCode?: string | null;
  limit?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
};

export type StaffListParams = {
  search?: string;
  limit?: number | undefined;
  page?: number | undefined;
  pageSize?: number | undefined;
  sortBy?: string | undefined;
  sortDir?: "asc" | "desc" | undefined;
};

export type EventListParams = {
  from?: string | null;
  to?: string | null;
  status?: "draft" | "finalized" | null;
  /** Narrow to Community Mass or leave on everything. Defaults to everything. */
  eventCategory?: EventCategory | "all" | null;
  limit?: number;
};

export type StudentReportParams = {
  period: ReportPeriod;
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  category?: StudentCategory | null;
  level?: string | null;
  departmentCode?: string | null;
  eventId?: string | null;
};

export type StaffReportParams = {
  period: ReportPeriod;
  from: string;
  to: string;
  groupBy: ReportGroupBy;
  /** One staff department name, or null for every staff member. */
  department?: string | null;
  eventId?: string | null;
};

export type CreateEventInput = {
  title: string;
  eventDate: string;
  /** Community Mass or other. Defaults to "other". */
  eventCategory?: EventCategory;
  startTime?: string | null;
  endTime?: string | null;
  category?: StudentCategory | null;
  level?: string | null;
  /** Student department codes in scope. Several means one event covering them all. */
  departmentCodes?: string[] | null;
  /** Staff department names in scope. Ignored for a student event. */
  departments?: string[] | null;
  notes?: string | null;
};

/**
 * The import payloads mirror what the API accepts, which is deliberately
 * forgiving: only a student's matric number is required, because that is the
 * one field a student row cannot be matched without. Everything else may be
 * absent and is read as "no value", the same way a blank cell in the registrar's
 * file is.
 */
export type ImportStudentsInput = {
  records: Array<{
    matricNo: string;
    lastName?: string | null;
    firstName?: string | null;
    middleName?: string | null;
    level?: string | null;
  }>;
};

export type ImportStaffInput = {
  records: Array<{
    /** Absent or blank for the rows whose file has no staff number. */
    staffNo?: string | null;
    lastName?: string | null;
    firstName?: string | null;
    middleName?: string | null;
    faculty?: string | null;
    department?: string | null;
    adminDepartment?: string | null;
  }>;
};

export const api = {
  /** The signed-in user, or null when the session cookie is missing or expired. */
  me: async (): Promise<Me | null> => {
    try {
      return await request<Me>("/api/auth/me");
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return null;
      throw error;
    }
  },
  signIn: (input: { email: string; password: string }) => post<Me>("/api/auth/signin", input),
  signUp: (input: { email: string; password: string; fullName: string }) =>
    post<Me>("/api/auth/signup", input),
  signOut: () => post<{ ok: boolean }>("/api/auth/signout"),
  setup: (input: { email: string; password: string; fullName?: string | undefined }) =>
    post<{ ok: boolean; me: Me }>("/api/setup", input),
  setupStatus: () => request<{ complete: boolean }>("/api/setup"),
  dashboard: () => request<Dashboard>("/api/dashboard"),

  students: (params: StudentListParams = {}) =>
    request<StudentList>(`/api/students${search(params)}`),
  studentsDownload: (
    params: {
      search?: string;
      category?: string | null;
      level?: string | null;
      departmentCode?: string | null;
    } = {},
  ) => requestBlob(`/api/students/download${search(params)}`),
  staff: (params: StaffListParams = {}) => request<StaffList>(`/api/staff${search(params)}`),
  staffDownload: (params: { search?: string } = {}) =>
    requestBlob(`/api/staff/download${search(params)}`),
  departments: () => request<string[]>("/api/departments"),
  levels: () => request<string[]>("/api/levels"),
  staffDepartments: () =>
    request<{ departments: StaffDepartmentOption[]; unassigned: number }>("/api/staff-departments"),
  importStudents: (input: ImportStudentsInput) => post<ImportResult>("/api/students/import", input),
  importStaff: (input: ImportStaffInput) => post<ImportResult>("/api/staff/import", input),

  studentEvents: (params: EventListParams = {}) =>
    request<StudentEvent[]>(`/api/student-events${search(params)}`),
  staffEvents: (params: EventListParams = {}) =>
    request<StaffEvent[]>(`/api/staff-events${search(params)}`),
  createStudentEvent: (input: CreateEventInput) =>
    post<StudentEvent>("/api/student-events", input as unknown as Record<string, unknown>),
  createStaffEvent: (input: CreateEventInput) =>
    post<StaffEvent>("/api/staff-events", input as unknown as Record<string, unknown>),
  studentEvent: (eventId: string) => request<EventResult>(`/api/student-events/${eventId}`),
  staffEvent: (eventId: string) => request<EventResult>(`/api/staff-events/${eventId}`),
  /**
   * Change an event that already exists. The scope may be changed too, which
   * moves who is expected: attendance is worked out from the current master list
   * every time a report runs, so narrowing or widening an event re-reads it.
   */
  updateEvent: (group: "student" | "staff", eventId: string, input: CreateEventInput) =>
    request<StudentEvent | StaffEvent>(`/api/${group}-events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteEvent: (group: "student" | "staff", eventId: string) =>
    request<{ ok: boolean }>(`/api/${group}-events/${eventId}`, { method: "DELETE" }),
  setEventStatus: (group: "student" | "staff", eventId: string, status: "draft" | "finalized") =>
    post<{ id: string }>(`/api/${group}-events/${eventId}/status`, { status }),
  uploadScans: (
    group: "student" | "staff",
    eventId: string,
    input: ScanUploadInput,
  ): Promise<{ upload: EventUpload; summary: EventSummary }> =>
    post(`/api/${group}-events/${eventId}/uploads`, input),
  eventExportUrl: (group: "student" | "staff", eventId: string) =>
    `/api/${group}-events/${eventId}/export`,

  studentReport: (params: StudentReportParams) =>
    request<ReportSeries>(`/api/reports/students${search({ ...params, format: "json" })}`),
  staffReport: (params: StaffReportParams) =>
    request<ReportSeries>(`/api/reports/staff${search({ ...params, format: "json" })}`),
  studentReportUrl: (params: StudentReportParams) =>
    `/api/reports/students${search({ ...params, format: "csv" })}`,
  staffReportUrl: (params: StaffReportParams) =>
    `/api/reports/staff${search({ ...params, format: "csv" })}`,

  users: () => request<{ users: AppUser[] }>("/api/users"),
  setUserRole: (userId: string, role: AppRole) =>
    post<{ role: AppRole }>("/api/users/roles", { userId, role }),

  recurring: {
    list: () => request<RecurringTemplateWithSchedules[]>("/api/recurring"),
    get: (id: string) => request<RecurringTemplateWithSchedules>(`/api/recurring/${id}`),
    create: (input: RecurringTemplateInput) => post<RecurringTemplate>("/api/recurring", input),
    update: (id: string, input: UpdateRecurringTemplateInput) =>
      put<RecurringTemplate>(`/api/recurring/${id}`, input),
    delete: (id: string) => request<{ ok: boolean }>(`/api/recurring/${id}`, { method: "DELETE" }),
    generate: (id: string) => post<GenerateEventsResult>(`/api/recurring/${id}/generate`),
  },

  admin: {
    clearAllData: () => post<{ ok: boolean }>("/api/admin/clear-all"),
  },
};
