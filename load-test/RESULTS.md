# Load test results

Fill this in after each run. Copy the numbers from `load-test/results/mixed-load-latest.md`.
Quote a number only together with its row of context below.

## Run 1 (not recorded yet)

| | |
|---|---|
| Date | |
| Machine (CPU, RAM, OS) | |
| App | production build (`npm run build && npm start`) |
| Database | PostgreSQL 16, direct connection (5433), seeded |
| Redis / worker | running / running |
| Rate limits | off (`RATE_LIMIT_DISABLED=true`) |
| Users | 80 read + 20 write, 60 s, think time 300 ms |

| Metric | Result |
|---|---|
| Requests (per second) | |
| Read p50 / p95 / p99 | |
| Write p50 / p95 / p99 | |
| Error rate | |
| Bookings created / conflicts | |
| Winners for the one shared asset (must be 1) | |
| `integrity-check.sql`: rows returned (must be 0) | |

Slowest endpoints (from the k6 output, by `endpoint` tag):

-
