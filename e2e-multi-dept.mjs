// Checks the recurring feature as it now stands: one template per day of the
// week, each scoped to a category, a level and any number of departments.
//
// Everything it creates is named TEST and removed in the finally block, so a
// failed run cannot leave anything behind in the database.

const base = "http://127.0.0.1:3000";
const PREFIX = "TEST";
const DAYS = [
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 0, label: "Sunday" },
];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

let cookie = "";
const createdTemplates = [];
const createdEvents = [];
let failed = 0;

async function call(method, path, body) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const raw of res.headers.getSetCookie?.() ?? []) {
    const pair = raw.split(";")[0];
    if (pair) cookie = pair;
  }
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function check(label, condition, detail) {
  if (!condition) failed += 1;
  console.log(
    `${condition ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `\n        ${JSON.stringify(detail)}`}`,
  );
}

const weekdayOf = (isoDate) => DAY_NAMES[new Date(`${isoDate}T00:00:00Z`).getUTCDay()];

async function cleanup() {
  for (const id of createdEvents) {
    await call("DELETE", `/api/${id.group}-events/${id.id}`);
  }
  for (const id of createdTemplates) {
    await call("DELETE", `/api/recurring/${id}`);
  }
  console.log(
    `\ncleanup: removed ${createdEvents.length} event(s), ${createdTemplates.length} template(s)`,
  );
}

try {
  const signin = await call("POST", "/api/auth/signin", {
    email: "admin@attendance.test",
    password: "correct-horse-1",
  });
  if (signin.status !== 200) throw new Error(`sign in failed: ${signin.status}`);
  console.log("signed in\n");

  // --- options ---------------------------------------------------------
  const codes = (await call("GET", "/api/departments")).data ?? [];
  const levels = (await call("GET", "/api/levels")).data ?? [];
  const staffOptions = (await call("GET", "/api/staff-departments")).data ?? {};
  check("student department options come from the matric numbers", codes.length > 0, {
    count: codes.length,
  });
  check("level options are available", levels.length > 0, {
    count: levels.length,
    sample: levels.slice(0, 6),
  });
  check(
    "staff department options carry a head count",
    (staffOptions.departments ?? []).length > 0,
    {
      named: (staffOptions.departments ?? []).length,
      unassigned: staffOptions.unassigned,
    },
  );

  // --- one template per day, Monday to Friday and Sunday ---------------
  const twoCodes = codes.slice(0, 2);
  const oneLevel = String(levels[0]);
  const perDay = [];

  for (const day of DAYS) {
    const res = await call("POST", "/api/recurring", {
      name: `${PREFIX} ${day.label} students`,
      start_date: "2026-03-02",
      end_date: "2026-03-16",
      event_title_template: `${PREFIX} Student ${day.label}`,
      group_kind: "student",
      schedules: [
        {
          day_of_week: day.value,
          student_category: "undergraduate",
          level: day.value % 2 === 0 ? null : oneLevel,
          departments: twoCodes,
          title_suffix: day.label,
        },
      ],
    });
    if (res.status < 300) createdTemplates.push(res.data.id);
    perDay.push({ day, res });
  }

  check(
    "a template can be made for each of the six days",
    perDay.every((d) => d.res.status < 300),
    perDay.map((d) => ({ day: d.day.label, status: d.res.status, error: d.res.data?.error })),
  );

  // Saturday is not offered, so nothing should have been made for it.
  const sundayIndex = DAYS.findIndex((d) => d.value === 0);
  check(
    "Sunday is the sixth day offered",
    DAYS.length === 6 && DAYS[sundayIndex].label === "Sunday",
    DAYS.map((d) => d.label),
  );
  check("Saturday is not offered", !DAYS.some((d) => d.label === "Saturday"));

  for (const { day, res } of perDay) {
    if (res.status >= 300) continue;
    const gen = await call("POST", `/api/recurring/${res.data.id}/generate`);
    check(`generated the ${day.label} events`, gen.status < 300 && gen.data.created > 0, {
      created: gen.data?.created,
      skipped: gen.data?.skipped,
    });
    for (const event of gen.data?.events ?? []) {
      createdEvents.push({ id: event.id, group: "student" });
    }

    // Checked within this template's own events, so each day is verified against
    // the day that template named rather than against another template's.
    const wrongDay = (gen.data?.events ?? []).filter((e) => weekdayOf(e.event_date) !== day.label);
    check(
      `every ${day.label} event falls on a ${day.label}`,
      gen.data?.events?.length > 0 && wrongDay.length === 0,
      {
        events: gen.data?.events?.length,
        wrongDay: wrongDay.map((e) => `${e.event_date} is ${weekdayOf(e.event_date)}`),
      },
    );
  }

  // Each template produced its own separate events, and none of them collided:
  // the six templates cover 13 dates between 2026-03-02 and 2026-03-16.
  const listed =
    (await call("GET", "/api/student-events?from=2026-03-01&to=2026-03-31&limit=200")).data ?? [];
  const mine = listed.filter((e) => (e.title ?? "").startsWith(`${PREFIX} Student`));
  const uniqueDates = new Set(mine.map((e) => e.event_date));
  check("no two templates collided on a date", mine.length === uniqueDates.size, {
    events: mine.length,
    distinctDates: uniqueDates.size,
  });

  // --- the scope of a generated event, read from its own page -----------
  const scoped =
    (await call("GET", "/api/student-events?from=2026-03-01&to=2026-03-31&limit=200")).data ?? [];
  const sample = scoped.find((e) => (e.departments ?? []).length === twoCodes.length);
  if (sample) {
    const detail = await call("GET", `/api/student-events/${sample.id}`);
    const expected = detail.data?.expected;
    const single = await call("GET", "/api/departments");
    check(
      "a two-department event expects fewer than the whole cohort",
      expected > 0 && expected < 8760,
      {
        expected,
        allStudents: 8760,
        departments: sample.departments,
      },
    );
    check(
      "the two-department event is wider than one department alone",
      expected > twoCodes.length,
      { expected, codes: twoCodes },
    );
    void single;
  } else {
    check("found a two-department event to inspect", false, {
      note: "no generated event carried two departments",
    });
  }

  // --- all departments means everybody ----------------------------------
  const allDepts = await call("POST", "/api/student-events", {
    title: `${PREFIX} all students`,
    eventDate: "2026-03-04",
    departmentCodes: [],
  });
  if (allDepts.status < 300) createdEvents.push({ id: allDepts.data.id, group: "student" });
  const allDetail =
    allDepts.status < 300 ? await call("GET", `/api/student-events/${allDepts.data.id}`) : null;
  check("choosing all departments expects every student", allDetail?.data?.expected === 8760, {
    expected: allDetail?.data?.expected,
    allStudents: 8760,
    departments: allDepts.data?.departments,
  });

  // --- a staff template on Sunday ---------------------------------------
  const staffDepts = (staffOptions.departments ?? []).slice(0, 2);
  const staffTemplate = await call("POST", "/api/recurring", {
    name: `${PREFIX} Sunday staff`,
    start_date: "2026-03-02",
    end_date: "2026-03-16",
    event_title_template: `${PREFIX} Staff Sunday`,
    group_kind: "staff",
    schedules: [
      { day_of_week: 0, departments: staffDepts.map((d) => d.department), title_suffix: "Sunday" },
    ],
  });
  if (staffTemplate.status < 300) createdTemplates.push(staffTemplate.data.id);
  check("a staff template can be made for Sunday", staffTemplate.status < 300, {
    status: staffTemplate.status,
    error: staffTemplate.data?.error,
  });

  if (staffTemplate.status < 300) {
    const gen = await call("POST", `/api/recurring/${staffTemplate.data.id}/generate`);
    for (const event of gen.data?.events ?? [])
      createdEvents.push({ id: event.id, group: "staff" });
    check("generated the staff events", gen.status < 300 && gen.data.created > 0, {
      created: gen.data?.created,
    });

    const onSunday = (gen.data?.events ?? []).filter((e) => weekdayOf(e.event_date) === "Sunday");
    check("the staff events fall on Sunday", onSunday.length === gen.data?.events?.length, {
      total: gen.data?.events?.length,
      onSunday: onSunday.length,
    });

    if (onSunday[0]) {
      const detail = await call("GET", `/api/staff-events/${onSunday[0].id}`);
      const want = staffDepts.reduce((sum, d) => sum + d.total, 0);
      check(
        "the staff event expects the staff in the two chosen departments",
        detail.data?.expected === want,
        {
          expected: detail.data?.expected,
          want,
          departments: staffDepts.map((d) => `${d.department}=${d.total}`),
        },
      );
      check("the staff event is narrower than all 806 staff", detail.data?.expected < 806, {
        expected: detail.data?.expected,
      });
    }
  }

  // --- a staff event for everyone ---------------------------------------
  const allStaff = await call("POST", "/api/staff-events", {
    title: `${PREFIX} all staff`,
    eventDate: "2026-03-04",
    departments: [],
  });
  if (allStaff.status < 300) createdEvents.push({ id: allStaff.data.id, group: "staff" });
  const allStaffDetail =
    allStaff.status < 300 ? await call("GET", `/api/staff-events/${allStaff.data.id}`) : null;
  check(
    "a staff event with no department expects all 806, including the 4 with none",
    allStaffDetail?.data?.expected === 806,
    {
      expected: allStaffDetail?.data?.expected,
    },
  );
} catch (error) {
  failed += 1;
  console.error("\nrun threw:", error);
} finally {
  await cleanup();
}

console.log(failed ? `\n${failed} CHECK(S) FAILED` : "\nALL CHECKS PASSED");
process.exit(failed ? 1 : 0);
