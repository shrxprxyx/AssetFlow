# Load tests (k6)

| Script | What it proves |
|---|---|
| `race.js` | 50 simultaneous requests at ONE asset or ONE room slot: exactly one wins, every other request gets a clean 409 |
| `mixed-load.js` | 100 concurrent users (80 readers, 20 writers): p95 latency, error rate, and that the one shared "hot" asset is never allocated twice |
| `integrity-check.sql` | Run after either test: the database must contain no double allocation, no overlapping booking, no duplicate finding |

## Run the mixed load test

Use a production build and a throwaway database, so the numbers mean something and your dev data stays clean.

```powershell
# 1. Install k6 once (https://grafana.com/docs/k6/latest/set-up/install-k6/)
winget install k6

# 2. A separate database for the test
docker compose up -d
docker compose exec postgres psql -U assetflow -d postgres -c "CREATE DATABASE assetflow_load;"

# 3. In ONE terminal: point the app at it, switch the rate limits off, build and start
$env:DATABASE_URL = "postgresql://assetflow:assetflow@localhost:5433/assetflow_load?schema=public"
$env:DIRECT_URL   = $env:DATABASE_URL
$env:RATE_LIMIT_DISABLED = "true"      # load tests only: 100 users from one machine would hit the limits
$env:AUTH_TRUST_HOST = "true"          # needed for "npm start" on localhost (NextAuth refuses unknown hosts in production mode)
npx prisma migrate deploy
npx prisma db seed
npm run build
npm start

# 4. In a SECOND terminal (worker too, so notifications behave as in production)
$env:DATABASE_URL = "postgresql://assetflow:assetflow@localhost:5433/assetflow_load?schema=public"
$env:DIRECT_URL   = $env:DATABASE_URL
npm run worker

# 5. In a THIRD terminal (the app in step 3 must still be running: k6 stops with "Nothing is listening" otherwise)
k6 run load-test/mixed-load.js

# 6. Check the data (PowerShell has no "<" redirect, so pipe the file in)
Get-Content load-test/integrity-check.sql | docker compose exec -T postgres psql -U assetflow -d assetflow_load
```

`DURATION`, `READ_VUS`, `WRITE_VUS` and `THINK_MS` can be changed with `-e`, for example `k6 run -e DURATION=120s load-test/mixed-load.js`.

The run fails (non-zero exit) if any threshold is missed:

| Threshold | Limit |
|---|---|
| Read p95 | under 500 ms |
| Write p95 | under 1000 ms |
| Errors (409 conflicts excluded) | under 1 % |
| Winners for the shared hot asset | at most 1 |

## Where results go

k6 writes `load-test/results/mixed-load-latest.md` and `.json` after every run. Copy the numbers into `load-test/RESULTS.md` together with the machine and settings, so a result is never quoted without its context. These tests run against `localhost`, on a laptop that also runs the database, Redis and k6 itself, so treat the numbers as a baseline, not a capacity claim.

## Read the results honestly

- **Nothing here measures the network.** Client and server share one machine.
- **Rate limits are off on purpose.** They are tested separately in `tests/rate-limit*.test.ts`.
- **Direct database connection.** The steps above skip PgBouncer. To include it, point `DATABASE_URL` at port 6432 (with `pgbouncer=true`) for the `assetflow` database on a fresh volume.
