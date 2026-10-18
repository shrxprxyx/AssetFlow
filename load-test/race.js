// Fires 50 simultaneous requests at ONE asset / ONE resource and asserts that
// exactly one succeeds while every other request gets a clean 409.
//
//   Allocation race:
//     k6 run -e COOKIE="authjs.session-token=<value>" -e ASSET_ID=1 -e HOLDER_ID=2 load-test/race.js
//
//   Booking race:
//     k6 run -e SCENARIO=booking -e COOKIE="authjs.session-token=<value>" -e RESOURCE_ID=3 load-test/race.js
//
// Preconditions
//   - The signed-in user must be ADMIN or ASSET_MANAGER (allocation scenario).
//   - Allocation: the asset must be AVAILABLE (return it before re-running).
//   - Booking: re-running needs a fresh slot, e.g. add -e OFFSET_DAYS=4.
import http from "k6/http";
import { Counter } from "k6/metrics";

const created = new Counter("created_2xx");
const conflicts = new Counter("conflict_409");
const other = new Counter("other_status");

const SCENARIO = __ENV.SCENARIO || "allocation";
const BASE = __ENV.BASE_URL || "http://localhost:3000";

export const options = {
  scenarios: {
    race: { executor: "shared-iterations", vus: 50, iterations: 50, maxDuration: "30s" },
  },
  thresholds: {
    created_2xx: ["count==1"], // exactly one winner
    other_status: ["count==0"], // everything else must be a clean 409
  },
};

export function setup() {
  const offsetDays = Number(__ENV.OFFSET_DAYS || 3);
  const start = new Date(Date.now() + offsetDays * 24 * 3600 * 1000);
  start.setMinutes(0, 0, 0);
  const end = new Date(start.getTime() + 3600 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export default function (data) {
  const params = {
    headers: { "Content-Type": "application/json", Cookie: __ENV.COOKIE },
  };

  let res;
  if (SCENARIO === "booking") {
    res = http.post(
      `${BASE}/api/bookings`,
      JSON.stringify({
        resourceId: Number(__ENV.RESOURCE_ID),
        startTime: data.start,
        endTime: data.end,
        purpose: "race test",
      }),
      params
    );
  } else {
    res = http.post(
      `${BASE}/api/allocations`,
      JSON.stringify({
        assetId: Number(__ENV.ASSET_ID),
        holderId: Number(__ENV.HOLDER_ID),
        holderType: "EMPLOYEE",
      }),
      params
    );
  }

  if (res.status >= 200 && res.status < 300) created.add(1);
  else if (res.status === 409) conflicts.add(1);
  else other.add(1);
}
