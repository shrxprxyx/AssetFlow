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
- **A real bug was found.** 9 of 194 asset creations failed (409 "could not generate a unique asset tag"): simultaneous creates were all given the same tag. Fixed with a database sequence (see `lib/assetTag.ts`).
- **Not yet known:** which endpoint is slowest. The script now prints a per-endpoint table.

Next run: re-run after the asset tag fix, then once with `-e READ_VUS=8 -e WRITE_VUS=2` as a baseline. If that run is fast, the 100-user numbers are queueing and the work is raising throughput; if it is also slow, individual requests are expensive.
