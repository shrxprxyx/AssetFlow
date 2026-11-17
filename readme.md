# AssetFlow

**Enterprise Asset & Resource Management System**: a centralized platform for tracking, allocating, and maintaining physical assets and shared resources (equipment, furniture, vehicles, rooms) across any organization.

Originally built for the Odoo Hackathon, then re-engineered for correctness under concurrent load: PostgreSQL with database-level conflict guarantees, a background worker with a Redis job queue, and an automated test suite that fires concurrent requests at the database.

---

## What's in this version

| Area | Hackathon MVP | Current |
|---|---|---|
| Database | SQLite file | **PostgreSQL 16** (Docker), reached through **PgBouncer** (transaction pooling) |
| Double-allocation guard | `$transaction` check-then-create | Row lock on the asset **plus a partial unique index** (one `ACTIVE` allocation per asset) as the backstop |
| Booking overlap guard | Query-then-create | Row lock on the resource **plus a Postgres exclusion constraint** (`btree_gist`) as the backstop |
| Notifications | Written inside the request | **Queued on Redis (BullMQ) and written by a separate worker process**, with retries; falls back to inline if Redis is down |
| Overdue returns, booking status | Computed on page load | **Scheduled jobs** in the worker: overdue sweep (every 5 min), booking tick (every minute) |
| Transfers | Direct re-allocation | **Request and approval workflow**; approvers and the holder are notified |
| Maintenance | Free status changes | **Guarded state machine**, atomic transitions, lost/retired assets can't be sent for maintenance |
| Asset lifecycle | Status set in code only | Edit, mark lost / found, retire, dispose, each recorded in the asset's history |
| Auth guards | Session role | Every route re-checks the **database** role and that the account is still active |
| Testing | none | **Vitest suite** (100+ tests) including concurrent-request tests against real Postgres and Redis |
| UI shell | Hand-rolled sidebar | shadcn/ui `Sidebar`, **TanStack Table v8** sortable tables, toasts via `sonner` |

---

## Architecture

```mermaid
flowchart TB

subgraph USERS["Users"]
A1[Administrator]
A2[Asset Manager]
A3[Department Head]
A4[Employee]
end

subgraph WEB["Next.js 16 (web process)"]
  PAGES["Pages / client components"]
  API["API route handlers<br/>(Zod-validated, role-guarded)"]
end

subgraph WORKER["Worker process (npm run worker)"]
  EVT["Event worker<br/>(notifications, retries)"]
  SWEEP["Scheduled jobs<br/>overdue sweep · booking tick"]
end

subgraph INFRA["Docker"]
  PGB["PgBouncer :6432"]
  PG[("PostgreSQL 16 :5433")]
  REDIS[("Redis :6379<br/>BullMQ queues")]
end

USERS --> PAGES
PAGES -->|"fetch / mutate"| API
API -->|"audit entry + enqueue job"| REDIS
API --> PGB --> PG
REDIS --> EVT
REDIS --> SWEEP
EVT --> PGB
SWEEP --> PGB
```

New notifications reach the browser instantly over Server-Sent Events (see Live Notifications). A slow timer refresh remains as a safety net.

---

## Concurrency Guarantees

These are the core engineering decisions in this version. Each one is backed by a database constraint, not only by application code, and each is covered by tests that send many simultaneous requests.

### One active allocation per asset

```mermaid
flowchart LR

Request["Allocation request"] --> Tx["Transaction:<br/>lock the asset row (FOR UPDATE)"]
Tx --> Check["Is there already an ACTIVE allocation?"]
Check -->|"no"| Create["Create allocation, set asset ALLOCATED"]
Check -->|"yes"| Conflict["409 asset_already_allocated<br/>+ currentlyHeldBy"]
Create -.->|"if anything bypasses the lock"| Index["Partial unique index rejects (P2002)"]
Index -.-> Conflict
```

The row lock makes concurrent requests for one asset run one after another, so the check always sees committed state. The partial unique index is the actual guarantee: if anything ever slips past the application, the database rejects the second row and the API reports the same `409`.

```sql
CREATE UNIQUE INDEX "allocation_one_active_per_asset"
ON "Allocation" ("assetId")
WHERE "status" = 'ACTIVE';
```

Overdue allocations deliberately stay `ACTIVE`: that is the status the index protects, so an asset can't be handed to someone else while it is still out.

### Overlap-free resource booking

```mermaid
flowchart LR

Booker --> Req["Booking request<br/>(resource, start, end)"]
Req --> Lock["Transaction:<br/>lock the resource's Asset row"]
Lock --> Check["Overlap query"]
Check -->|"overlap"| Reject["409 booking_overlap"]
Check -->|"free"| Insert["Create booking; COMMIT"]
Insert -.->|"backstop"| Excl["Exclusion constraint on (resourceId, time range)"]
```

The lock is taken on the **resource's own row** rather than on its existing bookings, so it also works for a resource's very first booking. Adjacent slots (10:00 right after a 9:00–10:00 booking) are allowed; overlapping ones are rejected by the database even if two requests race.

```sql
ALTER TABLE "ResourceBooking" ADD CONSTRAINT "booking_no_overlap"
EXCLUDE USING gist ("resourceId" WITH =, tsrange("startTime", "endTime", '[)') WITH &&)
WHERE ("status" <> 'CANCELLED');
```

### Workflows that can be triggered twice

Maintenance approvals, transfer decisions, booking cancellations and asset status changes all re-read the record under a lock (or use a guarded `UPDATE ... WHERE status = ...`) so a double click or two open tabs can never apply the same step twice.

---

## Background Jobs

```mermaid
flowchart LR

Action["Any action<br/>(allocate, book, approve, ...)"] --> Log["logActivity()<br/>writes the audit entry"]
Log --> Queue["BullMQ queue 'events'"]
Log -.->|"Redis down"| Inline["handled inline instead"]
Queue --> Worker["Worker: who needs to know?<br/>writes notifications"]
Worker -.->|"fails"| Retry["retry: 2s, 4s, 8s, 16s"]
```

- **The audit trail is written immediately** and never depends on Redis.
- **Deciding who to notify** is handed to the worker, so a request doesn't wait for it. Failed jobs are retried with exponential backoff and kept for inspection.
- **If Redis is unreachable** the web app creates the notifications itself and stops trying Redis for 10 seconds (a circuit breaker), so an outage costs requests nothing. Notifications are delayed at worst, never lost.
- **Delivery is guaranteed by an outbox** (see Event Delivery below): the audit entry doubles as the list of events still to be turned into notifications.
- **Scheduled jobs** (registered idempotently, so restarting the worker never duplicates them):
  - *Booking tick, every minute:* reminds the booker 15 minutes before a booking starts (once), moves bookings `UPCOMING → ONGOING → COMPLETED`.
  - *Overdue sweep, every 5 minutes:* notifies the holder and the managers once per overdue allocation; "already flagged" is remembered in the activity log.
  - *Outbox relay, every 5 seconds:* delivers events that no job delivered (see below).

### Event Delivery (Outbox)

`ActivityLog` is the outbox. Every event is a row with `processedAt = NULL` until its notifications have been created.

1. **Write.** Converted code calls `recordActivity(tx, ...)` inside its own transaction, so the audit row is committed together with the change it describes: both exist or neither does. This covers allocate, return, booking create, reschedule and cancel, every transfer and maintenance step, asset edits and status changes, employee role, department and status changes, and every audit-cycle action. Only password reset and the overdue and booking-reminder sweeps still call `logActivity()` after their work (write, then deliver).
2. **Fast path.** After the commit, `dispatchActivity(id)` queues a job (or handles the event itself when Redis is down).
3. **Safety net.** The worker's relay runs every 5 seconds and processes unprocessed events older than 5 seconds, oldest first (50 per run). It covers a crash after the commit, Redis being down, and a job that failed.
4. **No duplicates.** `processActivityLog(id)` claims the row with `FOR UPDATE SKIP LOCKED`, so two workers never handle the same event at once, and notifications have a unique key (event, user, type), so handling an event twice notifies nobody twice.
5. **Poison events.** An event that keeps failing is retried up to 5 times (`processAttempts`) and then left alone. Find stuck events with:

   ```sql
   SELECT id, action, "processAttempts", "timestamp" FROM "ActivityLog" WHERE "processedAt" IS NULL;
   ```

   To retry one after fixing the cause: `UPDATE "ActivityLog" SET "processAttempts" = 0 WHERE id = <id>;`

**Deploying this change.** The migration marks every existing event as processed so nobody is notified about history. Old app or worker processes that are still running after the migration keep writing events and notify for them themselves, so the new relay would notify those a second time. Stop the old web app and worker before running `npx prisma migrate deploy`, then start the new ones. If you can't stop them, once the new code is the only code running, run `UPDATE "ActivityLog" SET "processedAt" = "timestamp" WHERE "processedAt" IS NULL AND "timestamp" < '<time the new code went live>';`.

A database hiccup (database unreachable, connection pool busy) does not count against an event's 5 attempts; only errors from the event's own processing do.

Not covered: code paths that still use `logActivity()` can lose their audit row if the server dies between the change and the log write (the notification half is covered for all of them). Emails are not part of the outbox.

---

## Authentication Flow

```mermaid
sequenceDiagram

actor User
participant Frontend as Next.js Client
participant NextAuth
participant PG as PostgreSQL

User->>Frontend: Email & Password
Frontend->>NextAuth: signIn("credentials", {...})
NextAuth->>PG: Find user by email (case-insensitive)
PG-->>NextAuth: User record
NextAuth->>NextAuth: active? then bcrypt.compare(password, hash)
NextAuth->>NextAuth: Issue JWT session (role, departmentId)
NextAuth-->>Frontend: Session established
Frontend-->>User: Redirect to Dashboard
```

- Signup always creates an **Employee**. Roles are assigned only by an Admin through the promote endpoint, which rejects `ADMIN` as a target.
- **Email verification:** a new account can't sign in until its emailed link is opened (the password is checked first, so the "not verified" message never reveals which addresses have accounts). Accounts that existed before this change are marked verified by the migration. Completing a password reset also verifies the address.
- **Session revocation:** every session carries the account's `sessionVersion`; `requireAuth` rejects a session whose version is stale. The version is bumped by a password reset, by deactivating or reactivating the account, and by "sign out everywhere". Sessions last 8 hours.
- Emails are stored trimmed and lowercase, and compared ignoring case, so `Priya@X.com` and `priya@x.com` are one account. Two simultaneous signups for one address can't both succeed.
- **Forgot password:** the login page links to a reset form. A reset link is single-use, expires after 30 minutes, and only a hash of its token is stored. Until a mail provider is configured, the email is printed to the console of the worker (`npm run worker`), so copy the link from there.
- The JWT carries the role for the UI only. **Every API route re-reads the role and account status from the database**, so a demoted or deactivated user loses access immediately, not when their token expires.

---

## Asset Lifecycle

```mermaid
stateDiagram-v2

[*] --> Available
Available --> Allocated: allocate
Allocated --> Available: return
Available --> UnderMaintenance: maintenance approved
Allocated --> UnderMaintenance: maintenance approved
UnderMaintenance --> Available: resolved
UnderMaintenance --> Allocated: resolved (still held)
Available --> Retired
Retired --> Disposed
Available --> Lost
Allocated --> Lost
UnderMaintenance --> Lost
Lost --> Available: found
Disposed --> [*]
```

Allocated and Under Maintenance are managed by the allocation and maintenance workflows and can't be set by hand; Lost, Found, Retired and Disposed are set through `POST /api/assets/:id/status`. Marking an allocated asset lost closes its allocation; losing or retiring a bookable asset cancels its upcoming bookings and notifies the bookers. A disposed asset is final. Every transition is written to `AssetHistory`.

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Framework | Next.js 16 (App Router, Turbopack) | Pages and API route handlers in one app |
| Language | TypeScript | |
| UI | Tailwind CSS v4, shadcn/ui (Base UI primitives) | Sidebar, dropdown, dialog, table, sheet, tooltip |
| Tables | TanStack Table **v8** | Pinned to v8; v9 is a breaking API rewrite |
| Toasts | sonner | |
| State | Zustand | Client state beyond server data |
| Forms | React Hook Form + Zod resolver | Inline field-level errors |
| Charts | Recharts | Utilization and maintenance-frequency |
| ORM | Prisma | Schema + migrations; raw-SQL migrations for the partial index and exclusion constraint |
| Database | PostgreSQL 16 + PgBouncer | Docker for local dev; migrations bypass the pooler via `DIRECT_URL` |
| Queue / jobs | Redis 7, BullMQ, ioredis | Separate worker process (`worker/`), run with `tsx` |
| Auth | NextAuth (Credentials) + bcryptjs | JWT sessions |
| Validation | Zod | Shared schemas in `src/lib/schemas.ts` |
| Testing | Vitest | Real Postgres (separate test database) and real Redis |

---

## Project Structure

Everything the app itself is made of lives under `src/`; the worker, database files, tests and config stay at the root. The worker imports from `src/lib/`.

```
assetflow/
├── src/
│   ├── app/
│   │   ├── (protected)/           # dashboard, assets, allocations, bookings, maintenance, audits, reports, activity, org-setup
│   │   ├── api/                   # route handlers: auth, assets, allocations, bookings, ...
│   │   ├── login/
│   │   ├── forgot-password/       # ask for a reset link
│   │   ├── reset-password/        # choose a new password (from the emailed link)
│   │   └── page.tsx               # redirects to /login
│   ├── components/                # app-sidebar, topbar, notifications-bell, pager, search-select, QR label and scanner, ui/ (shadcn)
│   ├── lib/
│   │   ├── prisma.ts              # Prisma client singleton
│   │   ├── schemas.ts             # Zod schemas
│   │   ├── guards.ts              # requireAuth(): role + active status read from the database
│   │   ├── http.ts                # JSON body + validation-error helpers for routes
│   │   ├── pagination.ts          # ?page / ?pageSize parsing + the { data, total, page, pageSize } response
│   │   ├── allocations.ts         # allocate / return, row lock + unique-index backstop
│   │   ├── transfers.ts           # transfer request and approval workflow
│   │   ├── bookings.ts            # booking rules, row lock, cancel, reschedule
│   │   ├── maintenance.ts         # maintenance state machine
│   │   ├── assetLifecycle.ts      # edit + lost / found / retire / dispose
│   │   ├── audits.ts              # audit scoping
│   │   ├── notifications.ts       # activity -> who should be notified
│   │   ├── logActivity.ts         # audit entry + hands notification work to the queue
│   │   ├── queue.ts               # BullMQ producer with fast-fail and circuit breaker
│   │   ├── mailer.ts              # sendMail() (console for now) + queued delivery
│   │   ├── passwordReset.ts       # reset tokens: issue, verify, consume
│   │   ├── sweeps.ts              # overdue sweep + booking tick (plain functions, testable)
│   │   └── userLookup.ts          # case-insensitive email lookup
│   ├── hooks/                     # use-mobile
│   ├── styles/                    # globals.css, design tokens
│   ├── types/next-auth.d.ts
│   ├── proxy.ts                   # runs before every request: redirects unauthenticated users to /login, 401s anonymous API calls
│   ├── auth.config.ts             # the part of NextAuth setup that is safe to run in proxy.ts
│   └── auth.ts                    # NextAuth config (Credentials, rate limit, email-verification check)
├── worker/
│   ├── runtime.ts             # starts the event worker + schedules the jobs
│   └── index.ts               # entry point: npm run worker
├── prisma/
│   ├── schema.prisma
│   ├── migrations/            # includes the partial unique index and exclusion constraint
│   └── seed.ts
├── tests/                     # Vitest suites + helpers
├── docker-compose.yml         # postgres, pgbouncer, redis
├── .env.example
└── README.md
```

---

## Getting Started (Windows / PowerShell)

### Prerequisites
- Node.js 22+ (20+ works)
- Docker Desktop

> **Tip:** keep the project outside OneDrive-synced folders. OneDrive scanning `node_modules` and `.next` can lock files and make `prisma generate` fail with `EPERM`.

### 1. Clone and install

```powershell
git clone <repo-url>
cd assetflow
npm install
```

### 2. Start Postgres, PgBouncer and Redis

```powershell
docker compose up -d
docker compose ps
```

| Service | Port | Used for |
|---|---|---|
| PostgreSQL | 5433 | migrations and tests (direct) |
| PgBouncer | 6432 | the running app and worker |
| Redis | 6379 | job queue |

### 3. Configure environment variables

```powershell
Copy-Item .env.example .env
npx auth secret    # paste the generated value into AUTH_SECRET
```

`.env` needs these values (see `.env.example`):

```
DATABASE_URL="postgresql://assetflow:assetflow@localhost:6432/assetflow?schema=public&pgbouncer=true"
DIRECT_URL="postgresql://assetflow:assetflow@localhost:5433/assetflow?schema=public"
REDIS_URL="redis://localhost:6379"
AUTH_SECRET="replace-with-a-long-random-string"
APP_URL="http://localhost:3000"
UPLOAD_DIR="./uploads"

# Optional: real email (without SMTP_HOST, emails are printed to the console)
SMTP_HOST="smtp.gmail.com"
SMTP_PORT="587"
SMTP_USER="you@gmail.com"
SMTP_PASS="your-app-password"
MAIL_FROM="AssetFlow <you@gmail.com>"
```

In production mode (`npm start`) NextAuth only accepts requests for a host it trusts: on a real server set `AUTH_URL` to the public address, and for local production runs (such as load tests) set `AUTH_TRUST_HOST="true"`. Development (`npm run dev`) needs neither.

`UPLOAD_DIR` is the folder where uploaded photos are kept (optional; the default is `./uploads`). It is not in git. On a server, point it at a persistent volume and include it in backups.

`APP_URL` is the address used in password-reset links. It is optional in development (the request's own address is used) and required in production.

**Email.** Verification and password-reset emails are sent over SMTP when `SMTP_HOST` is set (port 587 uses STARTTLS, 465 uses TLS; `MAIL_FROM` is required with it). Gmail needs an *app password* (Google account, 2-step verification on), not your normal password. Without `SMTP_HOST` the emails are printed to the console of the process that sends them: the worker terminal when Redis is running, otherwise the `npm run dev` terminal. The worker reads `.env` too, so restart it after changing these values. A server that refuses an email makes the queue retry it; if SMTP is half-configured (host without sender) sending fails loudly instead of dropping mail.

`DATABASE_URL` goes through PgBouncer; `DIRECT_URL` goes straight to Postgres because migrations can't use transaction pooling.

### 4. Migrate and seed

```powershell
npx prisma generate
npx prisma migrate dev
npx prisma db seed
```

### 5. Run (two terminals)

```powershell
npm run dev        # terminal 1: the web app on http://localhost:3000
npm run worker     # terminal 2: the background worker
```

The app works without the worker running: notifications created in the meantime wait in Redis and are delivered when the worker starts. Scheduled jobs (overdue sweep, booking reminders and status changes) only run while the worker is up.

Seeded accounts (password `password123`):

| Email | Role |
|---|---|
| `admin@assetflow.com` | Admin |
| `manager@assetflow.com` | Asset Manager |
| `head@assetflow.com` | Department Head |
| `priya.shah@assetflow.com` | Employee |

---

## Live Notifications

The bell opens one `EventSource` to `GET /api/notifications/stream`. Whenever notifications are saved, whether by a web request or by the worker, their user ids are published on a Redis channel; every web process forwards that to the matching open streams. The event carries no text: the bell just reloads `GET /api/notifications`, so access rules stay in one place.

- Up to 5 open streams per user (a sixth gets `429`).
- A heartbeat every 25 seconds keeps idle connections alive through proxies. Behind nginx or similar, buffering must be off (the stream sends `X-Accel-Buffering: no`).
- A stream ends after 30 minutes and the browser reconnects by itself, which re-checks the session.
- If Redis is down, only the process that created the notification pushes it; the 60-second refresh catches the rest.

## Audit Cycles

1. **Create** (Admin): name, scope (all assets, a department, or a location), dates, and **one or more auditors** (Admin, Asset Manager or Department Head). Auditors are notified.
2. **Check** (assigned auditors only): mark each asset in scope Verified, Missing or Damaged. Assets outside the cycle's scope are refused. There is one finding per asset per cycle, enforced by a unique index; changing a verdict sends an earlier decision back to pending.
3. **Discrepancy report**: Missing and Damaged findings are collected automatically, with who flagged them.
4. **Decide** (Asset Manager or Admin): approve (confirm) or reject (dismiss) each flagged asset.
5. **Close** (Admin): refused while any flagged asset is undecided. Closing locks the cycle; approved Missing assets become Lost (their open allocation is closed and upcoming bookings cancelled); rejected ones are left alone.

## Photo Uploads

Assets and maintenance requests can carry a photo. The form uploads the file to `POST /api/uploads` (multipart, field `file`), gets back a path such as `/api/files/<random>.jpg`, and saves that path in `photoUrl`. `GET /api/files/<name>` serves it to signed-in users only.

- **Accepted:** JPEG, PNG and WebP up to 5 MB. The type is read from the file's first bytes, not from its name or the browser's label, so an HTML or SVG file renamed `.png` is refused. Files are served with `nosniff` and a sandboxing `Content-Security-Policy`.
- **Names:** files are stored under a random UUID; only names of that exact shape are ever read from disk, so paths like `../..` never reach the file system.
- **Limits:** 30 uploads per user per 10 minutes, on top of the general write limit.
- **`photoUrl` accepts** an uploaded path or a plain `http(s)` link (older records). Other values, such as `javascript:`, are refused.
- **Storage is swappable.** Everything goes through the `FileStore` interface in `src/lib/storage.ts` (`put`, `get`, `delete`); the default `LocalDiskStore` writes to `UPLOAD_DIR`. To use S3 or MinIO later, add one class and change `getStore()`: the saved paths, pages and forms stay the same.
- **Not done:** a photo that is replaced or removed stays on disk, and photos uploaded but never saved are not cleaned up. Local disk also assumes one server, or a shared volume, until the store is swapped.

## Rate Limiting

Counters live in Redis (one fixed window per key), so the limits hold across every web instance. If Redis is down they fall back to per-process memory instead of rejecting requests. A blocked request gets `429` with a `Retry-After` header and `{ "error": "rate_limited", "retryAfterSec": n }`.

| What | Limit | Counted by |
|---|---|---|
| Sign-in | 10 attempts / 15 min | account email (cleared by a correct password) |
| Sign-in | 30 attempts / 15 min | caller address, across all accounts |
| Sign-up | 10 / hour | caller address |
| Forgot password | 10 / hour | caller address |
| Reset password | 20 / hour | caller address |
| Any POST, PUT, PATCH, DELETE | 120 / minute | signed-in user |

Reads are not limited. Load tests switch the limits off with `RATE_LIMIT_DISABLED=true` (see Load Testing). All numbers are in `src/lib/rateLimit.ts` (`LIMITS`). The caller address comes from `X-Forwarded-For`, so run the app behind a proxy or load balancer that sets it.

## Load Testing

`load-test/` has two k6 scripts and an integrity check. `race.js` fires 50 simultaneous requests at one asset or one room slot and expects exactly one winner. `mixed-load.js` runs 80 readers and 20 writers together and reports p95 latency per kind of request, the error rate, and whether the one shared "hot" asset was ever allocated twice. After a run, `integrity-check.sql` confirms the database holds no double allocation, overlapping booking or duplicate finding. Setup steps are in `load-test/README.md`; results are recorded in `load-test/RESULTS.md`.

Rate limits would block 100 users on one machine, so load tests start the app with `RATE_LIMIT_DISABLED=true`. Only the exact value `true` switches them off, and a warning is printed. Never set it on a real server.

## Testing

```powershell
# one-time: a separate database, because the tests wipe their tables
docker compose exec postgres psql -U assetflow -d postgres -c "CREATE DATABASE assetflow_test;"

npm test               # run everything
npm run test:watch     # re-run affected tests on save
```

The tests call the real route handlers and library code against a real Postgres (`assetflow_test`; they refuse to run against any database whose name doesn't end in `_test`). They cover:

- **Concurrency:** many simultaneous allocations, bookings, approvals, cancellations, status changes and sign-ups, asserting that exactly one succeeds and the database constraints hold when the application checks are bypassed.
- **Permissions:** every role against the protected routes, deactivated users, stale session roles.
- **Workflows:** maintenance, transfers, booking rules, asset lifecycle, returns.
- **Background jobs:** the overdue sweep and booking tick, queue fallback logic, and (when Redis is running) the real worker, including an unreachable-Redis scenario.

The worker tests use Redis database 15 and are skipped automatically if Redis isn't running.

---

## Data Model Reference

| Entity | Key Fields | Constraint / Index |
|---|---|---|
| `User` | email, passwordHash, role, departmentId, status | `email` unique (stored lowercase); roles writable only via the Admin-guarded promote endpoint |
| `Department` | name, parentDeptId, headId, status | Self-referencing FK; the API refuses parent loops |
| `AssetCategory` | name, customFields (JSON) | `name` unique |
| `Asset` | assetTag, categoryId, departmentId, serialNumber, condition, location, isBookable, status | `assetTag` and `serialNumber` unique; `departmentId` is the owning department (optional, stays put while the asset is lent out; the holder is the active `Allocation`); a department that owns assets can't be deleted |
| `AssetHistory` | assetId, fromStatus, toStatus, actorId, reason | Immutable log of every status transition |
| `Allocation` | assetId, holderId, expectedReturnDate, status | **Partial unique index: one `ACTIVE` allocation per asset**; index on `(assetId, status)` |
| `TransferRequest` | assetId, fromHolderId, toHolderId, status | Pending, approved, rejected, cancelled |
| `ResourceBooking` | resourceId, bookerId, startTime, endTime, status, reminderSent | **Exclusion constraint: no overlapping non-cancelled bookings per resource** |
| `MaintenanceRequest` | assetId, requesterId, priority, status, technicianId | Pending, Approved, In Progress, Resolved / Rejected |
| `AuditCycle` | name, scopeType, scopeId, scopeLocation, startDate, endDate, status | Scope is `ALL`, a department, or a location text |
| `AuditAssignment` | cycleId, auditorId | One row per assigned auditor; only they can record findings |
| `AuditFinding` | cycleId, assetId, auditorId, status, resolutionStatus | One per asset per cycle (unique). `MISSING` / `DAMAGED` findings need an approve or reject decision. Closing flips approved-`MISSING` assets to `LOST`, closes their open allocation and cancels their upcoming bookings |
| `Notification` | userId, type, message, relatedResourceType/Id, isRead | |
| `ActivityLog` | actorId, action, resourceType, resourceId, changes (JSON) | Audit trail; every mutation calls `logActivity()` |

Full schema: `prisma/schema.prisma`.

---

## API Conventions

Base URL: `/api` (Next.js route handlers under `src/app/api/`).

```json
// Errors
{ "error": "machine_readable_code", "message": "Human readable", "field": "email" }

// Allocation conflict (409)
{ "error": "asset_already_allocated", "message": "...", "currentlyHeldBy": { "id": 7, "name": "..." } }
```

Sessions use NextAuth's JWT cookie.

**Pagination.** List endpoints take `?page=` (default 1) and `?pageSize=` (default 25, capped at 100) and answer:

```json
{ "data": [], "total": 137, "page": 2, "pageSize": 25 }
```

`total` counts every row matching the filters and the caller's role, not just the current page. This applies to assets, allocations, employees, activity, transfers, maintenance requests, audit cycles and asset history. Departments, categories and bookable resources are small master-data lists used as dropdowns and are returned whole; notifications return the latest 20; bookings are a per-day view.

| Method | Route | Who | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Creates an Employee account only |
| `POST` | `/api/auth/forgot-password` | Public | Emails a reset link; answers the same whether or not the account exists |
| `POST` | `/api/auth/verify-email` | Public | Confirms the address from the emailed link (single use, 24 h) |
| `POST` | `/api/auth/resend-verification` | Public | Sends a new link; answers the same whether or not the account exists; one email a minute per account |
| `POST` | `/api/account/sign-out-everywhere` | Signed in | Ends every session of the caller, this one included |
| `POST` | `/api/auth/reset-password` | Public | `{ token, password }`; the link works once and expires after 30 minutes |
| `POST` | `/api/employees/:id/promote` | Admin | The only place a role is assigned |
| `GET` | `/api/assets` | Signed in | Paginated; `?q=` searches tag, name, serial and location (case-insensitive), plus `categoryId`, `departmentId` and `status` filters |
| `GET` | `/api/activity` | Signed in | Paginated audit log; `?category=ALERTS\|APPROVALS\|BOOKINGS` |
| `POST` | `/api/assets` | Admin, Asset Manager | Register an asset (optional `departmentId`, must be an active department) |
| `GET` / `PATCH` | `/api/assets/:id` | Signed in / Admin, Asset Manager | Read / edit details (`departmentId` can be set, changed or cleared with `null`) |
| `POST` | `/api/assets/:id/status` | Admin, Asset Manager | Lost, found, retire, dispose |
| `GET` | `/api/assets/:id/history` | Signed in | Status history |
| `POST` | `/api/allocations` | Admin, Asset Manager, Dept Head | `409 asset_already_allocated` if held; department heads only within their department |
| `POST` | `/api/allocations/:id/return` | Holder / manager | Marks returned, records condition, asset back to `AVAILABLE` |
| `POST` | `/api/allocations/transfer` | Signed in | Request a transfer (managers' own requests are approved immediately) |
| `PATCH` | `/api/transfers/:id` | Approvers / requester | `{ "action": "approve" \| "reject" \| "cancel" }` |
| `GET` / `POST` | `/api/bookings` | Signed in | Day view / book (not in the past, max 12 h, `409 booking_overlap`) |
| `PATCH` | `/api/bookings/:id` | Booker, Admin, Asset Manager | Reschedule a booking that hasn't started (`startTime`, `endTime`, optional `purpose`); same overlap rules as booking, may overlap its own old time; re-arms the reminder |
| `DELETE` | `/api/bookings/:id` | Booker, Admin, Asset Manager | Cancel an upcoming or in-progress booking |
| `GET` / `POST` | `/api/maintenance-requests` | Signed in | List / raise |
| `PATCH` | `/api/maintenance-requests/:id` | Managers, assigned technician | Approve, reject, assign, start, resolve |
| `GET` / `POST` | `/api/audit-cycles` | Admin (create) | Cycles; create takes `auditorIds` (one or more) and, for `LOCATION` scope, `scopeLocation` |
| `POST` / `DELETE` | `/api/audit-cycles/:id/auditors` | Admin | Add auditors / remove one (`?auditorId=`); one must remain |
| `PATCH` | `/api/audit-cycles/:id/findings` | Assigned auditors | Verified / Missing / Damaged; the asset must be in the cycle's scope |
| `GET` | `/api/audit-cycles/:id/discrepancies` | Admin, Asset Manager, Dept Head | Discrepancy report: flagged assets, who flagged them, decision status |
| `PATCH` | `/api/audit-cycles/:id/findings/:findingId/resolution` | Admin, Asset Manager | `{ decision: APPROVED \| REJECTED }` |
| `POST` | `/api/audit-cycles/:id/close` | Admin | Needs every flagged finding decided; approved Missing becomes Lost |
| `POST` | `/api/uploads` | Signed in | Upload a photo (multipart `file`, JPEG/PNG/WebP, max 5 MB); returns `{ url }` |
| `GET` | `/api/files/:name` | Signed in | Serve an uploaded photo |
| `GET` | `/api/notifications` | Signed in | Your notifications |
| `GET` | `/api/notifications/stream` | Signed in | Event stream: `notification` when you get new ones (max 5 open per user) |
| `GET` | `/api/reports`, `/api/dashboard` | Managers / signed in | Utilization, maintenance frequency, KPIs |
| `GET` | `/api/reports/heatmap?days=7\|30\|90&tz=` | Managers | Booking utilisation by weekday and hour (cancelled bookings excluded) |

---

## User Roles

| Role | Capabilities |
|---|---|
| **Admin** | Departments, categories, audit cycles, employee/role management, everything an Asset Manager can do |
| **Asset Manager** | Register, edit and allocate assets, lost / found / retire / dispose, approve transfers and maintenance, cancel any booking, record audit findings |
| **Department Head** | View department assets, approve department transfer requests, allocate within their department, book shared resources |
| **Employee** | View own assets, book resources, raise maintenance requests, request transfers and returns |

---

## Screens

1. Login / Signup
2. Dashboard (KPIs, overdue highlights, quick actions)
3. Organization Setup (Departments, Categories, Employees), Admin only
4. Asset Registration & Directory (sortable table, edit and lifecycle actions)
5. Asset Allocation & Transfer (with approval inbox)
6. Resource Booking (day grid, overlap validation, reschedule, cancel)
7. Maintenance Management
8. Asset Audit (cycles, discrepancy reports)
9. Reports & Analytics
10. Activity Logs & Notifications

---

## Known Limitations

- Department audits still match assets by the department name appearing in the asset's location text. `Asset.departmentId` now exists, but audits have not been switched to it, and existing assets have no department until someone sets one.
- Foreign keys now cover `AssetHistory.actorId`, `MaintenanceRequest.technicianId`, `Allocation.holderDeptId` and `Notification.activityLogId`. Columns that can point at several tables (transfer from/to holders, audit `scopeId`, `resourceId`, `relatedResourceId`) deliberately have none; the API validates them.
- Day-view boundaries for bookings use the server's timezone.
- Password-reset events and the overdue and booking-reminder sweeps still write their entry with `logActivity()`, after their own work, so a crash in between can lose that entry. Every other change writes its audit entry in the same transaction (see Event Delivery).
- Photos live on the app server's disk (`UPLOAD_DIR`); old and unsaved uploads are not deleted automatically.

---

## Roadmap

Done:

- [x] Redis + BullMQ event pipeline with a separate worker, retries and an inline fallback
- [x] Scheduled overdue sweep and booking reminder / status tick
- [x] Connection pooling (PgBouncer)
- [x] Transfer approval workflow
- [x] Asset lifecycle actions, booking cancellation and rescheduling
- [x] Server-side pagination on list endpoints (`{ data, total, page, pageSize }`)
- [x] Page controls with server-side search on the asset directory, activity log and employee directory
- [x] Password reset (single-use, hashed, 30-minute links; emails sent through the queue)
- [x] Automated test suite, including concurrency tests

Not built yet:

- [x] Real-time push (Server-Sent Events) replacing the notification timer
- [ ] Refresh-token rotation and email verification
- [ ] A real mail provider (reset emails are currently printed to the worker's console)
- [x] Page controls on allocations, transfer requests and audit cycles (maintenance stays a board of the newest 100)
- [x] Searchable pickers (`src/components/search-select.tsx`) on the allocation form (asset, employee, transfer-to) and the transfer request form: they search the server as you type, so any asset or employee can be found. `GET /api/employees` takes `?q=` (name or email, every word must match)
- [x] QR labels: the **QR** button on an asset row (managers) opens a printable label whose code is a link to `/assets?tag=AF-0001`; the **Scan** button reads a label with the camera (needs a browser with `BarcodeDetector`, i.e. Chrome or Android, and https or localhost). Signed-out visitors are sent to sign in and then back to the link (`callbackUrl`, same-site paths only)
- [ ] The auditor checklist (audit cycles) and the org-setup employee list still load only the first 100 rows
- [x] Redis-backed rate limiting on auth and write routes
- [x] Outbox pattern for atomic event publication (audit row committed with the change; relay delivers notifications; every change except password reset and the sweeps now uses it)
- [x] File upload for asset and maintenance photos (local disk behind a swappable `FileStore`; S3/MinIO is a drop-in later)
- [x] Multi-auditor assignment and audit discrepancy approval
- [x] k6 load tests: scripts, runbook and recorded results are in `load-test/` (before the outbox change, 100 users at 2 s think time gave read p95 96 ms, write p95 309 ms, 0 % errors, one winner for the shared asset; later runs missed the p95 targets and the cause is not found, see `load-test/RESULTS.md`)
- [ ] Extract the API into a standalone service (deliberately not done: a single Next.js app keeps the project simple to run)