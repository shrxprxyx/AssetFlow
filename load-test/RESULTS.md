# Load test results

Copy the numbers from `load-test/results/mixed-load-latest.md` after each run.
Quote a number only together with its row of context.

## Run 1: 2026-11-17, thresholds MISSED, data integrity PASSED

| | |
|---|---|
| Machine | one laptop running k6, the app, PostgreSQL, Redis and the worker together (CPU/RAM not recorded) |
| App | production build (`npm run build && npm start`), single process |
| Database | PostgreSQL 16 in Docker, direct connection (5433), freshly seeded |
| Rate limits | off (`RATE_LIMIT_DISABLED=true`) |
| Users | 80 read + 20 write, 60 s, think time 300 ms |

| Metric | Result | Threshold |
|---|---|---|
| Requests | 5,933 (94.8 per second) | |
| Read p50 / p95 / max | 705 ms / 924 ms / 1.30 s | p95 under 500 ms: **missed** |
| Write p50 / p95 / max | 858 ms / 1.27 s / 2.43 s | p95 under 1000 ms: **missed** |
| Error rate | 0.00 % | under 1 %: passed |
| Checks passed | 99.84 % (9 failed, all "asset created") | |
| Bookings created / conflicts | 192 / 2 | |
| Allocate-and-return cycles | 185 | |
| Winners for the one shared asset | 1 | at most 1: passed |
| `integrity-check.sql` | all 6 queries returned 0 rows | zero: passed |

What it shows

- **Integrity held under contention.** 20 writers fought over one asset and exactly one won; no double allocation, no overlapping booking, no status mismatch.
- **The server was saturated.** Even the fastest read took 253 ms, and the median was about 700 ms. About 95 requests per second looks like this machine's ceiling with everything on it, so requests queued. These are not latencies a single user would see.
- **A real bug was found.** 9 of 194 asset creations failed (409 "could not generate a unique asset tag"): simultaneous creates were all given the same tag. Fixed with a database sequence (see `services/assetTag.ts`).
- **Not yet known:** which endpoint is slowest. The script now prints a per-endpoint table.

Next run: re-run after the asset tag fix, then once with `-e READ_VUS=8 -e WRITE_VUS=2` as a baseline. If that run is fast, the 100-user numbers are queueing and the work is raising throughput; if it is also slow, individual requests are expensive.

## Run 2: 2026-11-17, after the asset-tag fix, read threshold MISSED, write PASSED, integrity not yet checked

Same setup as run 1 (80 read + 20 write, 60 s, think time 300 ms: a stress profile, about 330 requests per second offered, not 100 realistic users).

| Metric | Result | Threshold |
|---|---|---|
| Requests | 7,832 (125.5 per second) | |
| Read p95 | 627 ms | under 500 ms: **missed** |
| Write p95 | 849 ms | under 1000 ms: passed |
| Error rate | 0.00 % | passed |
| Checks passed | 100 % | |
| Winners for the one shared asset | 1 | passed |
| `integrity-check.sql` | not run for this run | |

What it shows

- **The asset-tag fix worked.** No failed "asset created" checks, down from 9 of 194.
- **Throughput rose from 95 to 125 requests per second**, mostly because the failed and retried creates are gone.
- **Latency is flat across endpoints.** Even cheap endpoints (for example notifications_read) have a p50 of about 335-525 ms. That points to a cost shared by every request (a saturated single Node process, with k6, Postgres, Redis and the worker on the same laptop), not to one slow query.
- **booking_create has the worst tail** (p95 3.76 s, max 6.4 s). `createBooking` holds the room's row lock for only three short statements, so this is queueing on a few room rows and/or the saturated process. Not proven yet.
- **Unexplained:** many endpoints share a max of about 3.1 s at the same moment, which looks like one stall (GC, pool wait or an OS pause). Not investigated.

The 500 ms and 1000 ms thresholds are my own guesses. They were not loosened to get a green run.

Next runs (these separate saturation from slow requests):
1. `k6 run -e READ_VUS=8 -e WRITE_VUS=2 load-test/mixed-load.js` (baseline)
2. `k6 run -e THINK_MS=2000 load-test/mixed-load.js` (realistic pacing)
3. Watch the Node process CPU in Task Manager during each, and run `integrity-check.sql` after.

## Runs 3 and 4: 2026-11-17, same build and database as run 2, thresholds PASSED

Run 3 is a baseline (8 read + 2 write VUs, think time 300 ms). Run 4 is realistic pacing (80 read + 20 write VUs, think time 2000 ms, about 100 users clicking every couple of seconds).

| Metric | Run 3: 10 VUs | Run 4: 100 users, 2 s think | Threshold |
|---|---|---|---|
| Requests per second | 31.3 | 48.0 | |
| Read p50 / p95 / max | 26 ms / 56 ms / 383 ms | 28 ms / 96 ms / 473 ms | p95 under 500 ms: passed |
| Write p50 / p95 / max | 41 ms / 86 ms / 416 ms | 46 ms / 309 ms / 547 ms | p95 under 1000 ms: passed |
| Error rate | 0.00 % | 0.00 % | passed |
| Checks passed | 100 % (1,850) | 100 % (3,139) | passed |
| Bookings created / conflicts | 78 / 3 | 140 / 9 | |
| Winners for the one shared asset | 1 | 1 | passed |
| `integrity-check.sql` | run once after all four runs (see below) | | |

What it shows

- **Individual requests are fast.** With 10 users the median is about 28 ms for every endpoint and the p95 is 69 ms. Run 2's 600-900 ms was queueing on a saturated machine, not slow queries.
- **100 realistic users pass both thresholds** with a wide margin on this laptop (everything on one machine, single Node process).
- **Ceiling.** The app sustained about 125 requests per second in run 2 (a stress profile, 0 errors) before latency climbed. Run 4 used about 48 per second.
- **Remaining tail.** In run 4 several read endpoints have a p95 of 350 ms against a p90 of about 58 ms, and many endpoints share a max of about 465 ms. That looks like occasional short stalls that hit whatever is in flight (garbage collection, the worker, the laptop). Not investigated, and not a threshold problem.
- **Booking writes** have the widest spread (p90 488 ms): the few bookable rooms are locked one at a time, so concurrent bookings of the same room wait for each other. That is the intended behaviour.
- Only one machine was used and CPU was not recorded. These numbers do not describe a deployed server.
