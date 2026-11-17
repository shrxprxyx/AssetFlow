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

​```mermaid
flowchart TB

subgraph USERS["Users"]
A1[Administrator]
A2[Asset Manager]
A3[Department Head]
A4[Employee]
end

subgraph WEB["Next.js 16 (web process)"]
  PAGES["Pages / client components"]
  API["API route handlers\n(Zod-validated, role-guarded)"]
end

subgraph WORKER["Worker process (npm run worker)"]
  EVT["Event worker\n(notifications, retries)"]
  SWEEP["Scheduled jobs\noverdue sweep · booking tick"]
end

subgraph INFRA["Docker"]
  PGB["PgBouncer :6432"]
  PG[("PostgreSQL 16 :5433")]
  REDIS[("Redis :6379\nBullMQ queues")]
end

USERS --> PAGES
PAGES -->|"fetch / mutate"| API
API -->|"audit entry + enqueue job"| REDIS
API --> PGB --> PG
REDIS --> EVT
REDIS --> SWEEP
EVT --> PGB
SWEEP --> PGB
​```

The browser refreshes notifications on a timer; there is no live push yet (see Roadmap).

---

## Concurrency Guarantees

These are the core engineering decisions in this version. Each one is backed by a database constraint, not only by application code, and each is covered by tests that send many simultaneous requests.

### One active allocation per asset

​```mermaid
flowchart LR

Request["Allocation request"] --> Tx["Transaction:\nlock the asset row (FOR UPDATE)"]
Tx --> Check["Is there already an ACTIVE allocation?"]
Check -->|"no"| Create["Create allocation, set asset ALLOCATED"]
Check -->|"yes"| Conflict["409 asset_already_allocated\n+ currentlyHeldBy"]
Create -.->|"if anything bypasses the lock"| Index["Partial unique index rejects (P2002)"]
Index -.-> Conflict
​```

The row lock makes concurrent requests for one asset run one after another, so the check always sees committed state. The partial unique index is the actual guarantee: if anything ever slips past the application, the database rejects the second row and the API reports the same `409`.

​```sql
CREATE UNIQUE INDEX "allocation_one_active_per_asset"
ON "Allocation" ("assetId")
WHERE "status" = 'ACTIVE';
​```

Overdue allocations deliberately stay `ACTIVE`: that is the status the index protects, so an asset can't be handed to someone else while it is still out.

### Overlap-free resource booking

​```mermaid
flowchart LR

Booker --> Req["Booking request\n(resource, start, end)"]
Req --> Lock["Transaction:\nlock the resource's Asset row"]
Lock --> Check["Overlap query"]
Check -->|"overlap"| Reject["409 booking_overlap"]
Check -->|"free"| Insert["Create booking; COMMIT"]
Insert -.->|"backstop"| Excl["Exclusion constraint on (resourceId, time range)"]
​```

The lock is taken on the **resource's own row** rather than on its existing bookings, so it also works for a resource's very first booking. Adjacent slots (10:00 right after a 9:00–10:00 booking) are allowed; overlapping ones are rejected by the database even if two requests race.

​```sql
ALTER TABLE "ResourceBooking" ADD CONSTRAINT "booking_no_overlap"
EXCLUDE USING gist ("resourceId" WITH =, tsrange("startTime", "endTime", '[)') WITH &&)
WHERE ("status" <> 'CANCELLED');
​```

### Workflows that can be triggered twice

Maintenance approvals, transfer decisions, booking cancellations and asset status changes all re-read the record under a lock (or use a guarded `UPDATE ... WHERE status = ...`) so a double click or two open tabs can never apply the same step twice.

---

## Background Jobs

​```mermaid
flowchart LR

Action["Any action\n(allocate, book, approve, ...)"] --> Log["logActivity()\nwrites the audit entry"]
Log --> Queue["BullMQ queue 'events'"]
Log -.->|"Redis down"| Inline["handled inline instead"]
Queue --> Worker["Worker: who needs to know?\nwrites notifications"]
Worker -.->|"fails"| Retry["retry: 2s, 4s, 8s, 16s"]
​```

- **The audit trail is written immediately** and never depends on Redis.
- **Deciding who to notify** is handed to the worker, so a request doesn't wait for it. Failed jobs are retried with exponential backoff and kept for inspection.
- **If Redis is unreachable** the web app creates the notifications itself and stops trying Redis for 10 seconds (a circuit breaker), so an outage costs requests nothing. Notifications are delayed at worst, never lost.
- **Scheduled jobs** (registered idempotently, so restarting the worker never duplicates them):
  - *Booking tick, every minute:* reminds the booker 15 minutes before a booking starts (once), moves bookings `UPCOMING → ONGOING → COMPLETED`.
  - *Overdue sweep, every 5 minutes:* notifies the holder and the managers once per overdue allocation; "already flagged" is remembered in the activity log.

---

## Authentication Flow

​```mermaid
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
​```

- Signup always creates an **Employee**. Roles are assigned only by an Admin through the promote endpoint, which rejects `ADMIN` as a target.
- Emails are stored trimmed and lowercase, and compared ignoring case, so `Priya@X.com` and `priya@x.com` are one account. Two simultaneous signups for one address can't both succeed.
- The JWT carries the role for the UI only. **Every API route re-reads the role and account status from the database**, so a demoted or deactivated user loses access immediately, not when their token expires.

---

## Asset Lifecycle

​```mermaid
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
​```

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
| Validation | Zod | Shared schemas in `lib/schemas.ts` |
| Testing | Vitest | Real Postgres (separate test database) and real Redis |

---

## Project Structure

​```
assetflow/
├── app/
│   ├── (protected)/           # dashboard, assets, allocations, bookings, maintenance, audits, reports, activity, org-setup
│   ├── api/                   # route handlers: auth, assets, allocations, bookings, ...
│   ├── login/
│   └── page.tsx               # redirects to /login
├── components/                # app-sidebar, topbar, notifications-bell, ui/ (shadcn)
├── lib/
│   ├── prisma.ts              # Prisma client singleton
│   ├── schemas.ts             # Zod schemas
│   ├── guards.ts              # requireAuth(): role + active status read from the database
│   ├── http.ts                # JSON body + validation-error helpers for routes
│   ├── allocations.ts         # allocate / return, row lock + unique-index backstop
│   ├── transfers.ts           # transfer request and approval workflow
│   ├── bookings.ts            # booking rules, row lock, cancellation
│   ├── maintenance.ts         # maintenance state machine
│   ├── assetLifecycle.ts      # edit + lost / found / retire / dispose
│   ├── audits.ts              # audit scoping
│   ├── notifications.ts       # activity -> who should be notified
│   ├── logActivity.ts         # audit entry + hands notification work to the queue
│   ├── queue.ts               # BullMQ producer with fast-fail and circuit breaker
│   ├── sweeps.ts              # overdue sweep + booking tick (plain functions, testable)
│   └── userLookup.ts          # case-insensitive email lookup
├── worker/
│   ├── runtime.ts             # starts the event worker + schedules the jobs
│   └── index.ts               # entry point: npm run worker
├── prisma/
│   ├── schema.prisma
│   ├── migrations/            # includes the partial unique index and exclusion constraint
│   └── seed.ts
├── tests/                     # Vitest suites + helpers
├── types/next-auth.d.ts
├── middleware.ts              # redirects unauthenticated users to /login
├── auth.ts                    # NextAuth config
├── docker-compose.yml         # postgres, pgbouncer, redis
├── .env.example
└── README.md
​```

---

## Getting Started (Windows / PowerShell)

### Prerequisites
- Node.js 22+ (20+ works)
- Docker Desktop

> **Tip:** keep the project outside OneDrive-synced folders. OneDrive scanning `node_modules` and `.next` can lock files and make `prisma generate` fail with `EPERM`.

### 1. Clone and install

​```powershell
git clone <repo-url>
cd assetflow
npm install
​```

### 2. Start Postgres, PgBouncer and Redis

​```powershell
docker compose up -d
docker compose ps
​```

| Service | Port | Used for |
|---|---|---|
| PostgreSQL | 5433 | migrations and tests (direct) |
| PgBouncer | 6432 | the running app and worker |
| Redis | 6379 | job queue |

### 3. Configure environment variables

​```powershell
Copy-Item .env.example .env
npx auth secret    # paste the generated value into AUTH_SECRET
​```

`.env` needs four values (see `.env.example`):

​```
DATABASE_URL="postgresql://assetflow:assetflow@localhost:6432/assetflow?schema=public&pgbouncer=true"
DIRECT_URL="postgresql://assetflow:assetflow@localhost:5433/assetflow?schema=public"
REDIS_URL="redis://localhost:6379"
AUTH_SECRET="replace-with-a-long-random-string"
​```

`DATABASE_URL` goes through PgBouncer; `DIRECT_URL` goes straight to Postgres because migrations can't use transaction pooling.

### 4. Migrate and seed

​```powershell
npx prisma generate
npx prisma migrate dev
npx prisma db seed
​```

### 5. Run (two terminals)

​```powershell
npm run dev        # terminal 1: the web app on http://localhost:3000
npm run worker     # terminal 2: the background worker
​```

The app works without the worker running: notifications created in the meantime wait in Redis and are delivered when the worker starts. Scheduled jobs (overdue sweep, booking reminders and status changes) only run while the worker is up.

Seeded accounts (password `password123`):

| Email | Role |
|---|---|
| `admin@assetflow.com` | Admin |
| `manager@assetflow.com` | Asset Manager |
| `head@assetflow.com` | Department Head |
| `priya.shah@assetflow.com` | Employee |

---

## Testing

​```powershell
# one-time: a separate database, because the tests wipe their tables
docker compose exec postgres psql -U assetflow -d postgres -c "CREATE DATABASE assetflow_test;"

npm test               # run everything
npm run test:watch     # re-run affected tests on save
​```

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
| `Asset` | assetTag, categoryId, serialNumber, condition, location, isBookable, status | `assetTag` and `serialNumber` unique |
| `AssetHistory` | assetId, fromStatus, toStatus, actorId, reason | Immutable log of every status transition |
| `Allocation` | assetId, holderId, expectedReturnDate, status | **Partial unique index: one `ACTIVE` allocation per asset**; index on `(assetId, status)` |
| `TransferRequest` | assetId, fromHolderId, toHolderId, status | Pending, approved, rejected, cancelled |
| `ResourceBooking` | resourceId, bookerId, startTime, endTime, status, reminderSent | **Exclusion constraint: no overlapping non-cancelled bookings per resource** |
| `MaintenanceRequest` | assetId, requesterId, priority, status, technicianId | Pending, Approved, In Progress, Resolved / Rejected |
| `AuditCycle` | name, scopeType, scopeId, startDate, endDate, status | |
| `AuditFinding` | cycleId, assetId, auditorId, status | Closing a cycle flips `MISSING` assets to `LOST` |
| `Notification` | userId, type, message, relatedResourceType/Id, isRead | |
| `ActivityLog` | actorId, action, resourceType, resourceId, changes (JSON) | Audit trail; every mutation calls `logActivity()` |

Full schema: `prisma/schema.prisma`.

---

## API Conventions

Base URL: `/api` (Next.js route handlers under `app/api/`).

​```json
// Errors
{ "error": "machine_readable_code", "message": "Human readable", "field": "email" }

// Allocation conflict (409)
{ "error": "asset_already_allocated", "message": "...", "currentlyHeldBy": { "id": 7, "name": "..." } }
​```

Sessions use NextAuth's JWT cookie. List endpoints currently return plain arrays (or `{ data, total }` with no paging); pagination is on the roadmap.

| Method | Route | Who | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Creates an Employee account only |
| `POST` | `/api/employees/:id/promote` | Admin | The only place a role is assigned |
| `GET` | `/api/assets` | Signed in | Search / filter (case-insensitive) |
| `POST` | `/api/assets` | Admin, Asset Manager | Register an asset |
| `GET` / `PATCH` | `/api/assets/:id` | Signed in / Admin, Asset Manager | Read / edit details |
| `POST` | `/api/assets/:id/status` | Admin, Asset Manager | Lost, found, retire, dispose |
| `GET` | `/api/assets/:id/history` | Signed in | Status history |
| `POST` | `/api/allocations` | Admin, Asset Manager, Dept Head | `409 asset_already_allocated` if held; department heads only within their department |
| `POST` | `/api/allocations/:id/return` | Holder / manager | Marks returned, records condition, asset back to `AVAILABLE` |
| `POST` | `/api/allocations/transfer` | Signed in | Request a transfer (managers' own requests are approved immediately) |
| `PATCH` | `/api/transfers/:id` | Approvers / requester | `{ "action": "approve" \| "reject" \| "cancel" }` |
| `GET` / `POST` | `/api/bookings` | Signed in | Day view / book (not in the past, max 12 h, `409 booking_overlap`) |
| `DELETE` | `/api/bookings/:id` | Booker, Admin, Asset Manager | Cancel an upcoming or in-progress booking |
| `GET` / `POST` | `/api/maintenance-requests` | Signed in | List / raise |
| `PATCH` | `/api/maintenance-requests/:id` | Managers, assigned technician | Approve, reject, assign, start, resolve |
| `GET` / `POST` | `/api/audit-cycles` | Admin (create) | Cycles |
| `PATCH` | `/api/audit-cycles/:id/findings` | Admin, Asset Manager | Verified / Missing / Damaged |
| `POST` | `/api/audit-cycles/:id/close` | Admin | Locks the cycle, Missing becomes Lost |
| `GET` | `/api/notifications` | Signed in | Your notifications |
| `GET` | `/api/reports`, `/api/dashboard` | Managers / signed in | Utilization, maintenance frequency, KPIs |

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
6. Resource Booking (day grid, overlap validation, cancel)
7. Maintenance Management
8. Asset Audit (cycles, discrepancy reports)
9. Reports & Analytics
10. Activity Logs & Notifications

---

## Known Limitations

- Closing an audit cycle marks missing assets `LOST` but does not close their open allocations (use *Mark found* to recover an asset).
- Audit findings aren't checked against the cycle's scope, `LOCATION` scope behaves like `ALL`, and discrepancies have no approval step.
- `MaintenanceRequest.technicianId` has no foreign key; the API validates the technician exists and is active when assigning.
- Day-view boundaries for bookings use the server's timezone.

---

## Roadmap

Done:

- [x] Redis + BullMQ event pipeline with a separate worker, retries and an inline fallback
- [x] Scheduled overdue sweep and booking reminder / status tick
- [x] Connection pooling (PgBouncer)
- [x] Transfer approval workflow
- [x] Asset lifecycle actions and booking cancellation
- [x] Automated test suite, including concurrency tests

Not built yet:

- [ ] Real-time push (Server-Sent Events) replacing the notification timer
- [ ] Refresh-token rotation, email verification, password reset
- [ ] Pagination on all list endpoints
- [ ] Redis-backed rate limiting on auth and write routes
- [ ] Outbox pattern for atomic event publication
- [ ] File upload for asset and maintenance photos
- [ ] Multi-auditor assignment and audit discrepancy approval
- [ ] k6 load tests: allocation race (script exists) and mixed read/write load at 100 VUs, with recorded results
- [ ] Extract the API into a standalone service (deliberately not done: a single Next.js app keeps the project simple to run)