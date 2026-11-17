// Mixed read/write load: 80 read VUs + 20 write VUs = 100 concurrent users.
//
//   k6 run -e BASE_URL=http://localhost:3000 load-test/mixed-load.js
//
// Run it against a PRODUCTION build (`npm run build && npm start`) and a throwaway
// database (see load-test/README.md). Start the app with RATE_LIMIT_DISABLED=true:
// 100 users from one machine would otherwise (rightly) hit the rate limits.
//
// What it measures
//   - p95 latency of reads and of writes, separately
//   - error rate (409 conflicts are expected on writes and don't count as errors)
//   - integrity under contention: every write VU also tries to allocate ONE shared
//     "hot" asset, so exactly one request may ever succeed (hot_asset_allocations <= 1)
//
// Environment
//   BASE_URL   http://localhost:3000
//   DURATION   60s
//   READ_VUS   80
//   WRITE_VUS  20
//   THINK_MS   300     pause between requests, to look like people rather than a flood
//   MANAGER_EMAIL / EMPLOYEE_EMAIL / PASSWORD   default to the seeded demo accounts
import http from "k6/http";
import { check, sleep } from "k6";
import { Counter } from "k6/metrics";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.0.4/index.js";

const BASE = __ENV.BASE_URL || "http://localhost:3000";
const DURATION = __ENV.DURATION || "60s";
const READ_VUS = Number(__ENV.READ_VUS || 80);
const WRITE_VUS = Number(__ENV.WRITE_VUS || 20);
const THINK_S = Number(__ENV.THINK_MS || 300) / 1000;
const PASSWORD = __ENV.PASSWORD || "password123";
const MANAGER_EMAIL = __ENV.MANAGER_EMAIL || "manager@assetflow.com";
const EMPLOYEE_EMAIL = __ENV.EMPLOYEE_EMAIL || "priya.shah@assetflow.com";

// A 409 (booking or allocation conflict) is a correct answer, not a failure.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

const hotAllocations = new Counter("hot_asset_allocations");
const bookingsCreated = new Counter("bookings_created");
const bookingConflicts = new Counter("booking_conflicts");
const allocationCycles = new Counter("allocation_cycles");

// Every endpoint, so the summary shows which one is slow. (A threshold that always passes
// is how k6 is told to keep a separate result for that tag.)
const ENDPOINTS = [
  "assets_list", "assets_filtered", "assets_search", "dashboard", "notifications", "activity",
  "allocations_list", "bookings_day", "transfers_list",
  "booking_create", "asset_create", "allocation_create", "allocation_return", "hot_asset_allocate", "notifications_read",
];
const perEndpoint = {};
for (const name of ENDPOINTS) perEndpoint[`http_req_duration{endpoint:${name}}`] = ["max>=0"];

export const options = {
  scenarios: {
    read_heavy: { executor: "constant-vus", vus: READ_VUS, duration: DURATION, exec: "readFlow" },
    write_light: { executor: "constant-vus", vus: WRITE_VUS, duration: DURATION, exec: "writeFlow" },
  },
  thresholds: {
    ...perEndpoint,
    "http_req_duration{kind:read}": ["p(95)<500"],
    "http_req_duration{kind:write}": ["p(95)<1000"],
    http_req_failed: ["rate<0.01"],
    checks: ["rate>0.99"],
    hot_asset_allocations: ["count<=1"], // the integrity check: never two winners
  },
};

/* ───────────────────────────── helpers ───────────────────────────── */

function login(email) {
  const csrfRes = http.get(`${BASE}/api/auth/csrf`);
  if (csrfRes.status === 0) {
    throw new Error(
      `Nothing is listening at ${BASE}. Start the app first (npm run build, then npm start) and run k6 in a separate terminal.`
    );
  }
  const csrf = csrfRes.json("csrfToken");
  http.post(
    `${BASE}/api/auth/callback/credentials`,
    { csrfToken: csrf, email, password: PASSWORD, json: "true" },
    { redirects: 0 }
  );
  const cookies = http.cookieJar().cookiesForURL(BASE);
  const name = Object.keys(cookies).find((k) => k.includes("session-token"));
  if (!name) throw new Error(`Could not sign in as ${email}. Is the app running, and is the database seeded?`);
  return `${name}=${cookies[name][0]}`;
}

const headers = (cookie) => ({ "Content-Type": "application/json", Cookie: cookie });

function get(path, cookie, endpoint) {
  const res = http.get(`${BASE}${path}`, { headers: headers(cookie), tags: { kind: "read", endpoint } });
  check(res, { [`${endpoint} 200`]: (r) => r.status === 200 });
  return res;
}

function send(method, path, body, cookie, endpoint) {
  return http.request(method, `${BASE}${path}`, JSON.stringify(body ?? {}), {
    headers: headers(cookie),
    tags: { kind: "write", endpoint },
  });
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/* ────────────────────────────── setup ────────────────────────────── */

export function setup() {
  const manager = login(MANAGER_EMAIL);
  const employee = login(EMPLOYEE_EMAIL);

  const resources = http.get(`${BASE}/api/resources`, { headers: headers(manager) }).json("resources") || [];
  const categories = http.get(`${BASE}/api/asset-categories`, { headers: headers(manager) }).json() || [];
  const people = http.get(`${BASE}/api/employees?pageSize=100`, { headers: headers(manager) }).json("data") || [];
  const holder = people.find((p) => p.email === EMPLOYEE_EMAIL) || people[0];

  if (resources.length === 0) throw new Error("No bookable resources found. Seed the database first.");
  if (categories.length === 0) throw new Error("No asset categories found. Seed the database first.");

  // The shared asset every writer will fight over.
  const hot = http.post(
    `${BASE}/api/assets`,
    JSON.stringify({ name: "LOAD TEST hot asset", categoryId: categories[0].id, condition: "GOOD" }),
    { headers: headers(manager) }
  );
  if (hot.status !== 201) throw new Error(`Could not create the hot asset: ${hot.status} ${hot.body}`);

  return {
    manager,
    employee,
    resourceIds: resources.map((r) => r.id),
    categoryId: categories[0].id,
    holderId: holder.id,
    hotAssetId: hot.json("id"),
  };
}

/* ───────────────────────────── read flow ──────────────────────────── */

export function readFlow(data) {
  // Half the readers are the employee, half the manager: different roles, different queries.
  const cookie = Math.random() < 0.5 ? data.employee : data.manager;
  const today = new Date().toISOString().slice(0, 10);

  const flows = [
    () => get("/api/assets?page=1&pageSize=25", cookie, "assets_list"),
    () => get(`/api/assets?page=${1 + Math.floor(Math.random() * 3)}&status=AVAILABLE`, cookie, "assets_filtered"),
    () => get(`/api/assets?q=${pick(["laptop", "room", "chair", "LT-", "projector"])}`, cookie, "assets_search"),
    () => get("/api/dashboard", cookie, "dashboard"),
    () => get("/api/notifications", cookie, "notifications"),
    () => get("/api/activity?pageSize=25", cookie, "activity"),
    () => get("/api/allocations?pageSize=25", cookie, "allocations_list"),
    () => get(`/api/bookings?resourceId=${pick(data.resourceIds)}&date=${today}`, cookie, "bookings_day"),
    () => get("/api/transfers?pageSize=25", cookie, "transfers_list"),
  ];

  pick(flows)();
  sleep(THINK_S * (0.5 + Math.random()));
}

/* ───────────────────────────── write flow ─────────────────────────── */

export function writeFlow(data) {
  const cookie = data.manager;

  // 1. Book a random one-hour slot. Collisions are expected and must come back as 409.
  const start = new Date();
  start.setUTCDate(start.getUTCDate() + 20 + Math.floor(Math.random() * 300));
  start.setUTCHours(Math.floor(Math.random() * 23), 0, 0, 0);
  const end = new Date(start.getTime() + 3600 * 1000);
  const booking = send(
    "POST",
    "/api/bookings",
    { resourceId: pick(data.resourceIds), startTime: start.toISOString(), endTime: end.toISOString(), purpose: "load test" },
    cookie,
    "booking_create"
  );
  check(booking, { "booking: 201 or 409": (r) => r.status === 201 || r.status === 409 });
  if (booking.status === 201) bookingsCreated.add(1);
  if (booking.status === 409) bookingConflicts.add(1);
  sleep(THINK_S);

  // 2. Register a new asset, allocate it, take it back: three writes that each take the asset's row lock.
  const created = send(
    "POST",
    "/api/assets",
    { name: `LT ${__VU}-${__ITER}`, categoryId: data.categoryId, condition: "GOOD" },
    cookie,
    "asset_create"
  );
  if (check(created, { "asset created": (r) => r.status === 201 })) {
    const assetId = created.json("id");
    const alloc = send(
      "POST",
      "/api/allocations",
      { assetId, holderType: "EMPLOYEE", holderId: data.holderId },
      cookie,
      "allocation_create"
    );
    if (check(alloc, { "allocated": (r) => r.status === 201 })) {
      const back = send("POST", `/api/allocations/${alloc.json("id")}/return`, { condition: "GOOD" }, cookie, "allocation_return");
      if (check(back, { "returned": (r) => r.status === 200 })) allocationCycles.add(1);
    }
  }
  sleep(THINK_S);

  // 3. Contention: everyone tries to take the one shared asset. At most one request, ever, may win.
  const hot = send(
    "POST",
    "/api/allocations",
    { assetId: data.hotAssetId, holderType: "EMPLOYEE", holderId: data.holderId },
    cookie,
    "hot_asset_allocate"
  );
  check(hot, { "hot asset: 201 or 409": (r) => r.status === 201 || r.status === 409 });
  if (hot.status === 201) hotAllocations.add(1);
  sleep(THINK_S);

  // 4. Clear the bell.
  send("POST", "/api/notifications", {}, data.employee, "notifications_read");
  sleep(THINK_S * (0.5 + Math.random()));
}

/* ───────────────────────────── summary ────────────────────────────── */

const ms = (v) => (v === undefined ? "n/a" : `${v.toFixed(0)} ms`);
const val = (data, name, stat) => data.metrics[name] && data.metrics[name].values[stat];

export function handleSummary(data) {
  const read = "http_req_duration{kind:read}";
  const write = "http_req_duration{kind:write}";
  const md = [
    `# Mixed load test, ${new Date().toISOString()}`,
    ``,
    `${READ_VUS} read VUs + ${WRITE_VUS} write VUs for ${DURATION}, think time about ${Math.round(THINK_S * 1000)} ms.`,
    ``,
    `| Metric | Result |`,
    `|---|---|`,
    `| Requests | ${val(data, "http_reqs", "count")} (${(val(data, "http_reqs", "rate") || 0).toFixed(1)} per second) |`,
    `| Read p50 / p95 / p99 | ${ms(val(data, read, "med"))} / ${ms(val(data, read, "p(95)"))} / ${ms(val(data, read, "p(99)"))} |`,
    `| Write p50 / p95 / p99 | ${ms(val(data, write, "med"))} / ${ms(val(data, write, "p(95)"))} / ${ms(val(data, write, "p(99)"))} |`,
    `| Error rate | ${((val(data, "http_req_failed", "rate") || 0) * 100).toFixed(2)} % |`,
    `| Checks passed | ${((val(data, "checks", "rate") || 0) * 100).toFixed(2)} % |`,
    `| Bookings created / conflicts (409) | ${val(data, "bookings_created", "count") || 0} / ${val(data, "booking_conflicts", "count") || 0} |`,
    `| Allocate-and-return cycles | ${val(data, "allocation_cycles", "count") || 0} |`,
    `| Winners for the one shared asset | ${val(data, "hot_asset_allocations", "count") || 0} (must be 1) |`,
    ``,
    `## Per endpoint (slowest first)`,
    ``,
    `| Endpoint | p50 | p95 | max |`,
    `|---|---|---|---|`,
    ...ENDPOINTS.map((name) => ({ name, m: data.metrics[`http_req_duration{endpoint:${name}}`] }))
      .filter((e) => e.m)
      .sort((a, b) => b.m.values["p(95)"] - a.m.values["p(95)"])
      .map((e) => `| ${e.name} | ${ms(e.m.values.med)} | ${ms(e.m.values["p(95)"])} | ${ms(e.m.values.max)} |`),
    ``,
    `After the run, execute load-test/integrity-check.sql: every query must return zero rows.`,
    ``,
  ].join("\n");

  return {
    stdout: textSummary(data, { indent: " ", enableColors: true }),
    "load-test/results/mixed-load-latest.json": JSON.stringify(data, null, 2),
    "load-test/results/mixed-load-latest.md": md,
  };
}
