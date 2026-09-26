// Removes only the rows this testing created. Anything not named TEST* is
// reported and left alone, so a real event can never be caught by the sweep.

const base = "http://127.0.0.1:3000";
const PREFIX = "TEST";
let cookie = "";
const keep = [];

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

const signin = await call("POST", "/api/auth/signin", {
  email: "admin@attendance.test",
  password: "correct-horse-1",
});
if (signin.status !== 200) {
  console.error("sign in failed", signin.status, signin.data);
  process.exit(1);
}

const isTest = (name) => (name ?? "").trim().toUpperCase().startsWith(PREFIX);

// --- events first, because a template's schedules cascade from it -----------
let removedEvents = 0;
for (const group of ["student", "staff"]) {
  for (const range of [
    ["2026-01-01", "2026-01-31"],
    ["2026-02-01", "2026-12-31"],
  ]) {
    const res = await call("GET", `/api/${group}-events?from=${range[0]}&to=${range[1]}&limit=200`);
    if (!Array.isArray(res.data)) {
      console.error(`cannot list ${group} events:`, res.status, res.data);
      process.exit(1);
    }
    for (const event of res.data) {
      if (!isTest(event.title)) {
        keep.push(`${group} event: ${event.title} (${event.event_date})`);
        continue;
      }
      const del = await call("DELETE", `/api/${group}-events/${event.id}`);
      if (del.status < 300) {
        removedEvents += 1;
        console.log(`deleted ${group} event ${event.id} "${event.title}" (${event.event_date})`);
      } else {
        console.error(`FAILED to delete ${group} event ${event.id}:`, del.status, del.data);
        process.exitCode = 1;
      }
    }
  }
}

// --- templates, which cascade to their schedules and their departments -----
const templates = await call("GET", "/api/recurring");
let removedTemplates = 0;
for (const template of templates.data ?? []) {
  if (!isTest(template.name)) {
    keep.push(`template: ${template.name}`);
    continue;
  }
  const del = await call("DELETE", `/api/recurring/${template.id}`);
  if (del.status < 300) {
    removedTemplates += 1;
    console.log(`deleted ${template.group_kind} template ${template.id} "${template.name}"`);
  } else {
    console.error(`FAILED to delete template ${template.id}:`, del.status, del.data);
    process.exitCode = 1;
  }
}

console.log(`\nremoved ${removedEvents} event(s), ${removedTemplates} template(s)`);
console.log(keep.length ? `left alone:\n  ${keep.join("\n  ")}` : "left alone: nothing");
