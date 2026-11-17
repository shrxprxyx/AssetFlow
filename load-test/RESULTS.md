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

## Runs 5-12: 2026-11-17, after the outbox change, realistic profile MISSED most runs, cause NOT found

Same machine and build as before (one laptop, `npm start`, single process, Postgres direct on 5433, rate limits off), database `assetflow_load` (about 1,000 assets and 3,000 events by the end). The worker was **not running** during these runs, so events stayed unprocessed in the outbox; that is not the cause of the slowdown (an idle worker costs nothing). Thresholds were not loosened.

| Run (clock, IST) | Profile | Read p95 | Write p95 | Req/s | Result |
|---|---|---|---|---|---|
| Run 4 (before, for reference) | realistic | 96 ms | 309 ms | 48.0 | passed |
| earlier (first failing run) | realistic | 1.52 s | 2.09 s | 39 | missed |
| 18:32 | realistic | 1.55 s | 1.93 s | 38.3 | missed |
| 18:38 | baseline (10 VUs) | 219 ms | 236 ms | 27.1 | passed (run 3 was 56 / 86 ms) |
| 18:41 | baseline, after `VACUUM (ANALYZE)` | 145 ms | 186 ms | 29.7 | passed |
| 18:42 | realistic | 153 ms | 288 ms | 47.9 | **passed** |
| 18:49 | realistic | 1.01 s | 1.32 s | 43.7 | missed |
| 18:51 (right after a server restart) | realistic | 1.23 s | 1.59 s | 41.6 | missed |
| 18:53 (second run straight after) | realistic | 2.62 s | 3.08 s | 36.1 | missed |
| 18:58 | realistic | 1.36 s | 1.66 s | 42.6 | missed |
| 19:02 (CPU and GC traced) | realistic | 812 ms | 459 ms | not recorded (3,167 requests) | read missed, write passed |

All runs: 0 % failed requests and 100 % checks passed. `integrity-check.sql` was not run after these runs.

What it shows

- **It is a tail problem, not slow requests.** Between stalls the same load runs at a median of about 30 ms and a p95 of 70-125 ms. The p95 fails because of freezes of 2-25 s in which every endpoint, reads and writes alike, waits 1-3 s and then completes together. The same load and code passed once (18:42) and failed most other times.
- **Ruled out, with evidence:**
  - *Postgres disk or checkpoints:* checkpoint times did not overlap the freezes and every `sync=` was 0.11 s or less.
  - *Postgres locks or load:* sampling `pg_stat_activity` during a run showed about 22 connections almost all idle (`ClientRead`), nothing active, and only brief lock waits (4 sessions for about a second).
  - *PgBouncer:* not in the path of these runs (the load-test setup connects directly).
  - *Redis:* healthy; its log shows only routine snapshots.
  - *Garbage collection:* the longest pause during load was about 20 ms; the heap rises and falls normally (no leak).
  - *Stale statistics or bloat:* at most 232 dead rows in any table, and the vacuum did not explain the difference.
  - *Warm-up:* a second back-to-back run was worse, not better.
  - *Login cost:* the script logs in twice, in `setup()`, not once per user.
  - *The worker:* it was not running.
- **The web process is almost out of CPU.** In the traced run the server process used 56 CPU-seconds in a 60-second run, about 94 % of one core, which is roughly 17-18 ms of CPU per request and a ceiling near 55 requests per second. During a 2-second freeze it used 1.2-1.7 cores, so it was busy, not waiting.
- **Possible regression, not proven.** Run 2 sustained about 125 requests per second. If that was the same single process, it spent at most about 8 ms of CPU per request, so the cost per request may have more than doubled since then. Nothing here shows which change did that, and nothing here clears or blames the outbox work.
- **Start-up herd.** The script has no ramp-up: all 100 users send a request in the first second, and that second's median was 844 ms. That is about 3 % of all requests and eats most of the 5 % tail that a p95 allows.
- **Not found:** which code spends the CPU, and what causes the long freezes. Each freeze looks like a convoy: requests pile up, are released together, and arrive in lockstep again.

Next steps (not done)

1. Capture a CPU profile of the server during one realistic run: stop the server, run `node --cpu-prof --cpu-prof-dir=prof --cpu-prof-interval=2000 node_modules\next\dist\bin\next start`, run the load once, stop the server with Ctrl+C, and total the time by function.
2. Add a short ramp-up to `mixed-load.js` so the first second is not a 100-request herd (this does not change any threshold).
3. Re-run with the worker running, since the real system will have it.

Tooling added 2026-11-18 (nothing has been run with it yet, so it changes no result above): `mixed-load.js` now ramps up (`RAMP_S`, default 10 s), and `profile-summary.mjs` totals a CPU profile by area and by function. Steps 1 and 2 above are now one command each; see "Find where the CPU goes" in `README.md`.

Side note: the web log prints "Redis unavailable, counting in memory for 10s" once each time the server starts. It comes from the rate limiter's Redis client being used before its connection is ready, falls back to memory for 10 s, and is harmless. It is not fixed yet.

## Runs 13-15: 2026-11-18, realistic profile (80 read + 20 write VUs, 1 minute)

| Run | Req/s | avg | median | p95 | read p95 | write p95 | Failed requests | Checks | Thresholds |
|---|---|---|---|---|---|---|---|---|---|
| 13 (about 00:26) | 38.4 | 2.01 s | 2.30 s | 3.25 s | 2.92 s | 3.97 s | 0 % | 100 % (2,367) | read and write **missed** |
| 14 (about 00:34) | 135.5 | 354 ms | 221 ms | 582 ms | 598 ms | 522 ms | 17.4 % | 85.4 % | read, checks and failures **missed** |
| 15 (about 00:43) | 175.5 | 229 ms | 227 ms | 369 ms | 328 ms | 448 ms | 0 % | 100 % (10,501) | **all passed** |

Run 15 detail: 382 allocate-and-return cycles, 319 bookings created and 63 booking collisions (all answered 409), exactly 1 allocation of the shared hot asset. Slowest endpoints were `allocation_return` (p95 498 ms) and `allocation_create` (p95 481 ms); every other endpoint had a p95 under 430 ms.

What it shows

- **The slowdown from runs 5-12 did not reproduce in run 15.** Throughput is about 4.5 times run 13 and the tail is about 9 times shorter, on the same code and the same load script.
- **Run 13 matches runs 5-12:** every endpoint, reads included, had a median of about 2.3 s (minimum about 10 ms) at about 38 requests per second. That is the signature of one saturated process queueing everything.
- **Run 14 is not a valid performance run.** Most writes failed (`booking`, `asset created` and `hot asset` failed 92-95 % of the time) while `RATE_LIMIT_DISABLED=true` was most likely not set for that server start, so the 120-writes-per-minute-per-user limit rejected them. The status codes were not recorded, so this is an inference, not a confirmed 429. Reads were fast (median 221 ms) because the expensive writes were being turned away early. This suggests the write path is what saturates the process, but run 15 shows it is fast when nothing else is wrong.
- **Cause of the slow runs: NOT found.** The profile taken for run 13 covered only launcher processes (0.9 s, 0.6 s and 8.7 s of mostly idle time), not the server, so it says nothing about the slowness. The code did not change between runs 13 and 15, so it is likely to be how the server was started (profiler flags, which terminal, environment) or the machine's state, but that is not confirmed.
- **Not run:** `integrity-check.sql` after any of these runs, and the load with the worker running.

Tooling added 2026-11-18: `mixed-load.js` now prints each unexpected response status once per virtual user and endpoint (for example `unexpected status 429 on booking_create (rate limiting is ON: ...)`), so a failing run says why.

Next steps (not done)

1. Run the realistic profile once more to confirm run 15 is stable, with `RATE_LIMIT_DISABLED=true` set in the same terminal as the server.
2. Run `integrity-check.sql` against the data these runs created.
3. If a slow run happens again, capture the server profile with `node --cpu-prof --cpu-prof-dir=prof node_modules/next/dist/bin/next start`, stop it with a single Ctrl+C, wait for it to exit, and read it with `node load-test/profile-summary.mjs prof --top 30`.
