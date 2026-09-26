import type { RowDataPacket } from "./db";
import { dialect, query, queryOne, type SqlParam } from "@/server/db";
import { percent, periodKey, periodLabel, periodRange, toCsv } from "@/lib/attendance";
import { GROUPS, type GroupConfig } from "@/server/events";
import { staffDepartmentOptions, studentDepartments } from "@/server/masters";
import type {
  EventResult,
  GroupKind,
  ReportBucket,
  ReportGroupBy,
  ReportPeriod,
  ReportQuery,
  ReportSeries,
  StaffReportQuery,
  StudentScope,
  ReportDetail,
} from "@/lib/types";

/**
 * Reports are derived, never stored.
 *
 * "Expected" is the current master list for the chosen scope, recalculated for
 * every request, so it is the same number in every bucket: it describes the
 * scope, not the day. "Present" is who actually scanned, counted once per
 * person per bucket, so a weekly or monthly percentage can never exceed 100%.
 */
type ReportOptions = {
  period: ReportPeriod;
  from: string;
  to: string;
  eventId?: string | null;
  groupBy: ReportGroupBy;
  group: GroupKind;
  scope: StudentScope;
  levels: string[];
  departments: string[];
};

type ScanRow = RowDataPacket & {
  event_date: string;
  person_id: string;
  name: string;
  code: string | null;
  level: string | null;
  category: string | null;
  department_code: string | null;
};

type IssueRow = RowDataPacket & {
  event_date: string;
  out_of_scope: number;
  unmatched: number;
};

type Bucket = {
  key: string;
  people: Set<string>;
  events: Set<string>;
  outOfScope: number;
  unmatched: number;
};

/**
 * Narrows a report to the people an event expects. Staff are scoped by
 * department alone: they have no level and no undergraduate/postgraduate split.
 * A group that is not scoped contributes no clause, so it stays the whole list.
 */
function scopeFragment(config: GroupConfig, scope: StudentScope, params: SqlParam[]): string {
  if (!config.scoped) return "1 = 1";
  const alias = config.personAlias;
  const clauses = ["1 = 1"];
  if (scope.category) {
    clauses.push(`(${config.category}) = ?`);
    params.push(scope.category);
  }
  if (scope.level) {
    clauses.push(`${config.level} = ?`);
    params.push(scope.level);
  }
  if (scope.departmentCode) {
    clauses.push(`(${config.department}) = ?`);
    // A student department is a short code, stored derived in upper case
    // (`CSC`), so it is matched upper case. A staff department is a free-text
    // name from the file ("Accounting"), kept as written, and matched under a
    // case-insensitive collation either way.
    params.push(
      config.kind === "student" ? scope.departmentCode.toUpperCase() : scope.departmentCode,
    );
  }
  return clauses.join(" AND ");
}

function asDate(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export async function buildReport(options: ReportOptions): Promise<ReportSeries> {
  const config = GROUPS[options.group];
  const from = asDate(options.from);
  const to = asDate(options.to);
  const valid = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to;
  const keys = valid ? periodRange(from, to, options.period) : [];

  const scanParams: SqlParam[] = [options.from, options.to];
  const issueParams: SqlParam[] = [options.from, options.to];
  const eventParams: SqlParam[] = [options.from, options.to];
  const eventFilter = options.eventId ? " AND e.id = ?" : "";
  if (options.eventId) {
    scanParams.push(options.eventId);
    issueParams.push(options.eventId);
    eventParams.push(options.eventId);
  }
  const scanScope = scopeFragment(config, options.scope, scanParams);

  // The expected head-count, counted over the master list under the same scope
  // the scans were filtered by. The bound values have to be kept and handed to
  // the query: a `?` in the WHERE clause with no parameter behind it fails at
  // execute time with "Incorrect arguments to mysqld_stmt_execute", which is
  // what a department filter used to do.
  const countParams: SqlParam[] = [];
  const countScope = scopeFragment(config, options.scope, countParams);
  const expectedRow = await queryOne<RowDataPacket & { total: number }>(
    `SELECT COUNT(*) AS total FROM ${config.people} ${config.personAlias}
     WHERE ${countScope}`,
    countParams,
  );

  const [scans, issues, events] = await Promise.all([
    valid
      ? query<ScanRow>(
          `SELECT e.event_date, ${config.personAlias}.id AS person_id,
                 ${config.name} AS name, ${config.code} AS code,
                 ${config.level} AS level,
                 ${config.category} AS category,
                 ${config.department} AS department_code
         FROM ${config.scans} sc
         JOIN ${config.events} e ON e.id = sc.event_id
         JOIN ${config.people} ${config.personAlias} ON ${config.personAlias}.id = sc.${config.idColumn}
         WHERE e.event_date BETWEEN ? AND ? ${eventFilter}
           AND sc.in_scope = 1 AND (${scanScope})
         ORDER BY e.event_date`,
          scanParams,
        )
      : Promise.resolve([] as ScanRow[]),
    valid
      ? query<IssueRow>(
          `SELECT e.event_date,
                COUNT(DISTINCT CASE WHEN sc.in_scope = 0 AND sc.${config.idColumn} IS NOT NULL
                                   THEN sc.${config.idColumn} END) AS out_of_scope,
                SUM(CASE WHEN sc.match_method = 'none' THEN 1 ELSE 0 END) AS unmatched
         FROM ${config.scans} sc
         JOIN ${config.events} e ON e.id = sc.event_id
         WHERE e.event_date BETWEEN ? AND ? ${eventFilter}
         GROUP BY e.event_date`,
          issueParams,
        )
      : Promise.resolve([] as IssueRow[]),
    valid
      ? query<RowDataPacket & { id: string; event_date: string }>(
          `SELECT e.id, e.event_date FROM ${config.events} e
         WHERE e.event_date BETWEEN ? AND ? ${eventFilter}
         ORDER BY e.event_date`,
          eventParams,
        )
      : Promise.resolve([] as Array<RowDataPacket & { id: string; event_date: string }>),
  ]);

  const expected = Number(expectedRow?.total ?? 0);

  const buckets = new Map<string, Bucket>();
  for (const key of keys) {
    buckets.set(key, { key, people: new Set(), events: new Set(), outOfScope: 0, unmatched: 0 });
  }
  const bucket = (key: string): Bucket => {
    const found = buckets.get(key);
    if (found) return found;
    const created: Bucket = {
      key,
      people: new Set(),
      events: new Set(),
      outOfScope: 0,
      unmatched: 0,
    };
    buckets.set(key, created);
    return created;
  };

  // Overall composition: how many distinct people turned up, split by each
  // dimension a report can be grouped on.
  const composition = {
    department: new Map<string, { label: string; people: Set<string> }>(),
    level: new Map<string, { label: string; people: Set<string> }>(),
    category: new Map<string, { label: string; people: Set<string> }>(),
  };
  const addTo = (
    map: Map<string, { label: string; people: Set<string> }>,
    key: string | null,
    label: string,
    personId: string,
  ) => {
    if (!key) return;
    const found = map.get(key) ?? { label, people: new Set<string>() };
    found.people.add(personId);
    map.set(key, found);
  };

  for (const row of scans) {
    bucket(periodKey(asDate(row.event_date), options.period)).people.add(row.person_id);
    addTo(composition.department, row.department_code, row.department_code ?? "", row.person_id);
    addTo(composition.level, row.level, row.level ? `Level ${row.level}` : "", row.person_id);
    addTo(
      composition.category,
      row.category,
      row.category === "undergraduate"
        ? "Undergraduate"
        : row.category === "postgraduate"
          ? "Postgraduate"
          : (row.category ?? ""),
      row.person_id,
    );
  }

  for (const event of events) {
    bucket(periodKey(asDate(event.event_date), options.period)).events.add(event.id);
  }
  for (const row of issues) {
    const target = bucket(periodKey(asDate(row.event_date), options.period));
    target.outOfScope += Number(row.out_of_scope ?? 0);
    target.unmatched += Number(row.unmatched ?? 0);
  }

  const toMap = (map: Map<string, { label: string; people: Set<string> }>) =>
    [...map.entries()].map(([key, entry]) => ({
      key,
      label: entry.label,
      value: entry.people.size,
    }));

  const attendees = new Set<string>();
  for (const entry of buckets.values()) {
    for (const person of entry.people) attendees.add(person);
  }

  return {
    period: options.period,
    from: options.from,
    to: options.to,
    grouped: options.groupBy !== "none",
    totals: {
      events: events.length,
      expected,
      present: attendees.size,
      absent: Math.max(expected - attendees.size, 0),
      out_of_scope: [...issues].reduce((sum, row) => sum + Number(row.out_of_scope ?? 0), 0),
      unmatched: [...issues].reduce((sum, row) => sum + Number(row.unmatched ?? 0), 0),
      percent: percent(attendees.size, expected),
    },
    buckets:
      options.groupBy === "none"
        ? keys.map((key) => {
            const entry = bucket(key);
            return {
              key,
              label: periodLabel(key, options.period),
              events: entry.events.size,
              expected,
              present: entry.people.size,
              absent: Math.max(expected - entry.people.size, 0),
              out_of_scope: entry.outOfScope,
              unmatched: entry.unmatched,
              percent: percent(entry.people.size, expected),
            } satisfies ReportBucket;
          })
        : groupBuckets(options, scans, expected),
    composition: toMap(composition.department),
    levels: options.levels,
    departments: options.departments,
    categories: toMap(composition.category),
  };
}

/**
 * Breakdowns by department, level or category. Expected is split across the
 * groups in proportion to who actually turned up, since the source files do not
 * record who was expected on which day, and out-of-scope and unmatched rows
 * belong to no group, so they stay in the totals.
 */
function groupBuckets(
  options: ReportOptions,
  scans: ScanRow[],
  expectedTotal: number,
): ReportBucket[] {
  type Group = { label: string; people: Set<string>; days: Set<string> };
  const groups = new Map<string, Group>();

  const keyFor = (scan: ScanRow): { key: string; label: string } => {
    if (options.groupBy === "department") {
      return {
        key: scan.department_code ?? "__none__department",
        label: scan.department_code ?? "No department",
      };
    }
    if (options.groupBy === "level") {
      return {
        key: scan.level ?? "__none__level",
        label: scan.level ? `Level ${scan.level}` : "No level",
      };
    }
    const label =
      scan.category === "undergraduate"
        ? "Undergraduate"
        : scan.category === "postgraduate"
          ? "Postgraduate"
          : "Uncategorised";
    return { key: scan.category ?? "__none__category", label };
  };

  for (const scan of scans) {
    const { key, label } = keyFor(scan);
    const group = groups.get(key) ?? { label, people: new Set<string>(), days: new Set<string>() };
    group.people.add(scan.person_id);
    group.days.add(scan.event_date);
    groups.set(key, group);
  }

  const attendance = [...groups.values()].reduce((sum, group) => sum + group.people.size, 0);
  return [...groups.entries()]
    .map(([key, group]) => {
      const expected =
        attendance === 0 || expectedTotal === 0
          ? 0
          : Math.max(Math.round((group.people.size / attendance) * expectedTotal), 1);
      const present = group.people.size;
      return {
        key,
        label: group.label,
        events: group.days.size,
        expected,
        present,
        absent: Math.max(expected - present, 0),
        out_of_scope: 0,
        unmatched: 0,
        percent: percent(present, expected),
      } satisfies ReportBucket;
    })
    .sort((a, b) => b.present - a.present);
}

export async function studentReport(input: ReportQuery): Promise<ReportSeries> {
  const [levels, departments] = await Promise.all([levelOptions(), studentDepartments()]);
  return buildReport({
    period: input.period,
    from: input.from,
    to: input.to,
    eventId: input.eventId ?? null,
    groupBy: input.groupBy,
    group: "student",
    scope: {
      category: input.category ?? null,
      level: input.level ?? null,
      departmentCode: input.departmentCode ?? null,
    },
    levels,
    departments,
  });
}

export async function staffReport(input: StaffReportQuery): Promise<ReportSeries> {
  // Staff have no level and no undergraduate/postgraduate split, so those two
  // groupings are not offered. A department breakdown is available: the staff
  // master carries one, and it is what a scoped staff event is selected on.
  return buildReport({
    period: input.period,
    from: input.from,
    to: input.to,
    eventId: input.eventId ?? null,
    groupBy: input.groupBy === "department" ? "department" : "none",
    group: "staff",
    scope: {
      category: null,
      level: null,
      departmentCode: input.department ?? null,
    },
    levels: [],
    departments: await staffDepartmentOptions(),
  });
}

export async function levelOptions(): Promise<string[]> {
  const rows = await query<RowDataPacket & { level: string }>(
    `SELECT DISTINCT level FROM students WHERE level IS NOT NULL ORDER BY ${dialect.intCast("level")}`,
  );
  return rows.map((row) => row.level);
}

// CSV exports ---------------------------------------------------------------

/**
 * Describes who an event expected, in words, for the export header. An event can
 * cover several departments, so they are all listed: an export that named only
 * the first one would claim a narrower event than was actually run.
 */
function eventScopeLabel(event: EventResult["event"]): string {
  const parts: string[] = [];
  const category = "category" in event ? event.category : null;
  const level = "level" in event ? event.level : null;
  const departments = "departments" in event ? event.departments : null;
  const legacyCode = "department_code" in event ? event.department_code : null;

  parts.push(category ?? "everyone");
  if (level) parts.push(`level ${level}`);

  const codes = departments?.length ? departments : legacyCode ? [legacyCode] : [];
  if (codes.length === 1) parts.push(`department ${codes[0]}`);
  else if (codes.length > 1) parts.push(`departments ${codes.join(" + ")}`);

  return parts.join(" + ");
}

/** One file per event: the header totals, then present, out of scope, absent, unmatched. */
export function eventCsv(result: EventResult): string {
  const event = result.event;
  const scope = eventScopeLabel(event);

  const lines: string[] = [
    `Event,${event.title}`,
    `Date,${event.event_date}`,
    `Scope,${scope}`,
    `Expected,${result.expected},Present,${result.present},Absent,${result.absent},Out of scope,${result.outOfScope},Unmatched,${result.unmatched},Percent,${result.percent ?? 0}`,
    "",
    toCsv(
      ["Status", "Name", "Code", "Level", "Department", "Scans", "First scan", "Last scan"],
      [
        ...result.presentList.map((row) => [
          "Present",
          row.name,
          row.code,
          row.level ?? "",
          row.department_code ?? "",
          row.scan_count,
          row.first_scan_at,
          row.last_scan_at,
        ]),
        ...result.outOfScopeList.map((row) => [
          "Out of scope",
          row.name,
          row.code,
          row.level ?? "",
          row.department_code ?? "",
          row.scan_count,
          "",
          "",
        ]),
        ...result.absentList.map((row) => [
          "Absent",
          row.name,
          row.code,
          row.level ?? "",
          row.department_code ?? "",
          "",
          "",
          "",
        ]),
        ...result.unmatchedList.map((row) => [
          "Unmatched",
          row.scanned_name ?? "",
          row.scan_number ?? "",
          "",
          "",
          row.scan_count,
          row.first_scan_at,
          row.last_scan_at,
        ]),
      ],
    ),
  ];
  return lines.join("\n");
}

/** Detailed CSV: present, absent, or all people with full details. */
export async function reportDetailCsv(
  options: {
    period: ReportPeriod;
    from: string;
    to: string;
    groupBy: ReportGroupBy;
    eventId?: string | null;
    scope: StudentScope;
    group: GroupKind;
    levels: string[];
    departments: string[];
  },
  detail: ReportDetail,
): Promise<string> {
  const config = GROUPS[options.group];
  const from = new Date(`${options.from}T00:00:00Z`);
  const to = new Date(`${options.to}T00:00:00Z`);
  const valid = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to;

  const scanParams: SqlParam[] = [options.from, options.to];
  const eventParams: SqlParam[] = [options.from, options.to];
  const eventFilter = options.eventId ? " AND e.id = ?" : "";
  if (options.eventId) {
    scanParams.push(options.eventId);
    eventParams.push(options.eventId);
  }
  const scanScope = scopeFragment(config, options.scope, scanParams);

  // Get all scans in range with person details
  const scans = valid
    ? await query<
        RowDataPacket & {
          person_id: string;
          name: string;
          code: string | null;
          level: string | null;
          category: string | null;
          department_code: string | null;
          event_date: string;
          event_id: string;
          scanned_at: string;
        }
      >(
        `SELECT ${config.personAlias}.id AS person_id,
                ${config.name} AS name,
                ${config.code} AS code,
                ${config.level} AS level,
                ${config.category} AS category,
                ${config.department} AS department_code,
                e.event_date,
                e.id AS event_id,
                sc.scanned_at
         FROM ${config.scans} sc
         JOIN ${config.events} e ON e.id = sc.event_id
         JOIN ${config.people} ${config.personAlias} ON ${config.personAlias}.id = sc.${config.idColumn}
         WHERE e.event_date BETWEEN ? AND ? ${eventFilter}
           AND sc.in_scope = 1 AND (${scanScope})
         ORDER BY e.event_date, ${config.personAlias}.id`,
        scanParams,
      )
    : ([] as Array<
        RowDataPacket & {
          person_id: string;
          name: string;
          code: string | null;
          level: string | null;
          category: string | null;
          department_code: string | null;
          event_date: string;
          event_id: string;
          scanned_at: string;
        }
      >);

  // Get all people in scope
  const allPeople = await query<
    RowDataPacket & {
      id: string;
      name: string;
      code: string | null;
      level: string | null;
      category: string | null;
      department_code: string | null;
    }
  >(
    `SELECT ${config.personAlias}.id, ${config.name} AS name, ${config.code} AS code,
            ${config.level} AS level, ${config.category} AS category, ${config.department} AS department_code
     FROM ${config.people} ${config.personAlias}
     WHERE ${scopeFragment(config, options.scope, [])}
     ORDER BY ${config.name}`,
    [],
  );

  // Group scans by person
  const personScans = new Map<string, typeof scans>();
  for (const scan of scans) {
    const list = personScans.get(scan.person_id) ?? [];
    list.push(scan);
    personScans.set(scan.person_id, list);
  }

  const presentIds = new Set(personScans.keys());
  const presentList = allPeople.filter((p) => presentIds.has(p.id));
  const absentList = allPeople.filter((p) => !presentIds.has(p.id));

  const headers = [
    "Status",
    "Name",
    "Code",
    "Level",
    "Department",
    "Category",
    "Events attended",
    "Total scans",
    "First scan",
    "Last scan",
  ];

  const rows: Array<Array<string | number | null>> = [];

  if (detail === "present" || detail === "all") {
    for (const person of presentList) {
      const pscans = personScans.get(person.id);
      if (!pscans || pscans.length === 0) continue;
      const eventsAttended = new Set(pscans.map((s) => s.event_id)).size;
      const totalScans = pscans.length;
      const firstScan = pscans[0]!.scanned_at;
      const lastScan = pscans[pscans.length - 1]!.scanned_at;
      rows.push([
        "Present",
        person.name,
        person.code ?? "",
        person.level ?? "",
        person.department_code ?? "",
        person.category ?? "",
        eventsAttended,
        totalScans,
        firstScan,
        lastScan,
      ]);
    }
  }

  if (detail === "absent" || detail === "all") {
    for (const person of absentList) {
      rows.push([
        "Absent",
        person.name,
        person.code ?? "",
        person.level ?? "",
        person.department_code ?? "",
        person.category ?? "",
        "",
        "",
        "",
        "",
      ]);
    }
  }

  const title = `${options.group === "student" ? "Student" : "Staff"} attendance ${options.from} to ${options.to}`;
  return `${title}\n\n${toCsv(headers, rows)}`;
}

export function reportCsv(series: ReportSeries, group: GroupKind): string {
  const headers = series.grouped
    ? ["Group", "Events", "Expected", "Present", "Absent", "Out of scope", "Unmatched", "Percent"]
    : ["Period", "Events", "Expected", "Present", "Absent", "Out of scope", "Unmatched", "Percent"];

  const rows: Array<Array<string | number>> = series.buckets.map((bucket) => [
    bucket.label,
    bucket.events,
    bucket.expected,
    bucket.present,
    bucket.absent,
    bucket.out_of_scope,
    bucket.unmatched,
    bucket.percent ?? "",
  ]);
  rows.push([
    "Total",
    series.totals.events,
    series.totals.expected,
    series.totals.present,
    series.totals.absent,
    series.totals.out_of_scope,
    series.totals.unmatched,
    series.totals.percent ?? "",
  ]);
  return `${group === "student" ? "Student" : "Staff"} attendance ${series.from} to ${series.to}\n\n${toCsv(headers, rows)}`;
}
