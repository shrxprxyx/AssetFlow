# AssetFlow

**Enterprise Asset & Resource Management System**: a centralized platform for tracking, allocating, and maintaining physical assets and shared resources (equipment, furniture, vehicles, rooms) across any organization.

Originally built for the Odoo Hackathon, then re-engineered for correctness under concurrent load: PostgreSQL, database-level conflict guarantees, and a rebuilt UI shell.

---

## What's in this version

| Area | Hackathon MVP | Current |
|---|---|---|
| Database | SQLite file | **PostgreSQL 16** (Docker) |
| Double-allocation guard | `$transaction` check-then-create | Transaction check **plus a Postgres partial unique index** (`one ACTIVE allocation per asset`) as the correctness backstop |
| Booking overlap guard | Query-then-create | **Row-level locking (`SELECT ... FOR UPDATE`)** inside the transaction so concurrent requests for one resource serialize |
| UI shell | Hand-rolled sidebar | shadcn/ui `Sidebar` (collapsible to icon mode, grouped, role-aware nav) + topbar with search, notifications, and user menu |
| Data tables | Plain `<table>` | **TanStack Table v8** with sortable columns |
| Feedback | Inline messages | Toast notifications via `sonner` |
| Infra | Single process | `docker-compose` for Postgres + Redis (Redis provisioned for the upcoming event queue) |

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

subgraph APP["Next.js 16 App Router"]
  subgraph PAGES["Pages / Client Components"]
    Dashboard
    OrgSetup["Organization Setup"]
    Assets
    Allocation
    Booking
    Maintenance
    Audit
    Reports
    Notifications
  end

  subgraph API["API Route Handlers (app/api/**)"]
    Routes["Zod-validated route handlers"]
    AuthLib["NextAuth (Credentials, JWT)"]
  end
end

subgraph STORAGE["Persistence (Docker)"]
  Prisma
  PG[(PostgreSQL 16)]
  Redis[(Redis — provisioned, not yet wired)]
end

USERS --> PAGES
PAGES -->|"fetch / mutate + refetch"| API
API --> AuthLib
API --> Prisma
Prisma --> PG
```

The UI refetches after mutations; there is no live push yet (see Roadmap).

---

## Concurrency Guarantees

These are the core engineering decisions in this version.

### One active allocation per asset

```mermaid
flowchart LR

Employee --> Request["Allocation Request"]
Request --> Tx["Prisma $transaction:\ncheck for existing ACTIVE allocation"]
Tx -->|"none found"| Create["Create Allocation + set Asset ALLOCATED"]
Tx -->|"already allocated"| Conflict["409 asset_already_allocated\n+ currentlyHeldBy"]
Create -->|"concurrent request won the race"| Index["Partial unique index rejects (P2002)"]
Index --> Conflict
Conflict --> Transfer["Transfer Request form"]
Create --> History["AssetHistory + logActivity()"]
```

The pre-check gives users a fast, friendly error. The partial unique index is the actual guarantee: if two requests pass the pre-check simultaneously, the database rejects the second and the API converts the constraint violation (Prisma `P2002`) into the same `409` response.

```sql
CREATE UNIQUE INDEX "allocation_one_active_per_asset"
ON "Allocation" ("assetId")
WHERE "status" = 'ACTIVE';
```

### Overlap-free resource booking

```mermaid
flowchart LR

Booker --> Req["Booking Request\n(resourceId, start, end)"]
Req --> Lock["BEGIN; SELECT ... FOR UPDATE\non the resource's non-cancelled bookings"]
Lock --> Check["Overlap query"]
Check -->|"overlap"| Reject["409 booking_overlap\n+ conflictingBooking"]
Check -->|"free"| Insert["Create ResourceBooking; COMMIT"]
```

Locking the resource's existing bookings makes concurrent requests for the same resource run one after another, so the overlap check always sees committed state. Adjacent slots (10:00 right after a 9:00-10:00 booking) are allowed; overlapping ones (9:30-10:30) are rejected.

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
NextAuth->>PG: Find user by email
PG-->>NextAuth: User record
NextAuth->>NextAuth: bcrypt.compare(password, hash)
NextAuth->>NextAuth: Issue JWT session (role, departmentId)
NextAuth-->>Frontend: Session established
Frontend-->>User: Redirect to Dashboard
```

Signup always creates an **Employee** account. Roles are assigned only by an Admin through the promote endpoint, which rejects `ADMIN` as a target role.

---

## Asset Lifecycle

```mermaid
stateDiagram-v2

[*] --> Available
Available --> Allocated
Allocated --> Available: Returned
Allocated --> UnderMaintenance
Available --> UnderMaintenance
UnderMaintenance --> Available
Available --> Reserved
Available --> Lost
Available --> Retired
Retired --> Disposed
Disposed --> [*]
```

Every transition is written to `AssetHistory`.

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
| ORM | Prisma | Type-safe schema + migrations, raw SQL migration for the partial index |
| Database | PostgreSQL 16 | Docker for local dev |
| Cache / queue infra | Redis 7 | Provisioned in `docker-compose.yml`; not yet consumed |
| Auth | NextAuth (Credentials) + bcryptjs | JWT sessions |
| Validation | Zod | Shared schemas in `lib/schemas.ts` |

---

## Project Structure

```
assetflow/
├── app/
│   ├── (protected)/           # dashboard, assets, allocations, bookings, maintenance, audits, reports, activity, org-setup
│   ├── api/                   # route handlers: auth, assets, allocations, bookings, ...
│   ├── login/
│   └── page.tsx               # redirects to /login
├── components/
│   ├── app-sidebar.tsx        # shadcn Sidebar, grouped + role-aware nav
│   ├── topbar.tsx             # search, notifications, user menu
│   └── ui/                    # shadcn primitives
├── lib/
│   ├── prisma.ts              # Prisma client singleton
│   ├── schemas.ts             # Zod schemas
│   ├── logActivity.ts         # shared activity-log helper
│   ├── allocations.ts         # allocation transaction + P2002 handling
│   └── bookings.ts            # row-locked booking overlap check
├── prisma/
│   ├── schema.prisma
│   ├── migrations/            # includes the partial unique index migration
│   └── seed.ts
├── types/next-auth.d.ts
├── proxy.ts / middleware.ts   # auth redirect for unauthenticated users
├── auth.ts                    # NextAuth config
├── docker-compose.yml         # postgres + redis
└── README.md
```

---

## Getting Started (Windows / PowerShell)

### Prerequisites
- Node.js 20+
- Docker Desktop

### 1. Clone and install

```powershell
git clone <repo-url>
cd assetflow
npm install
```

### 2. Start Postgres and Redis

```powershell
docker compose up -d
docker compose ps
```

### 3. Configure environment variables

Create `.env` at the project root:

```
DATABASE_URL="postgresql://assetflow:assetflow@localhost:5432/assetflow?schema=public"
AUTH_SECRET="replace-with-a-long-random-string"
```

Generate a secret with:
```powershell
npx auth secret
```

### 4. Migrate and seed

```powershell
npx prisma generate
npx prisma migrate dev
npx prisma db seed
```

### 5. Run

```powershell
npm run dev
```

Visit `http://localhost:3000`; it redirects to `/login`.

---

## Data Model Reference

| Entity | Key Fields | Constraint / Index |
|---|---|---|
| `User` | email, passwordHash, role, departmentId, status | `email` unique; roles writable only via the Admin-guarded promote endpoint |
| `Department` | name, parentDeptId, headId, status | Self-referencing FK for hierarchy |
| `AssetCategory` | name, customFields (JSON) | |
| `Asset` | assetTag, categoryId, serialNumber, condition, location, isBookable, status | `assetTag` and `serialNumber` unique |
| `AssetHistory` | assetId, fromStatus, toStatus, actorId, reason | Immutable log of every lifecycle transition |
| `Allocation` | assetId, holderId, expectedReturnDate, status | **Partial unique index: one `ACTIVE` allocation per asset** |
| `TransferRequest` | assetId, fromHolderId, toHolderId, status | Requested, auto-approved, re-allocated |
| `ResourceBooking` | resourceId, bookerId, startTime, endTime, status | Overlap rejected under a row lock |
| `MaintenanceRequest` | assetId, requesterId, priority, status, technicianId | Pending, Approved, Technician Assigned, In Progress, Resolved |
| `AuditCycle` | name, scopeType, scopeId, startDate, endDate, status | |
| `AuditFinding` | cycleId, assetId, auditorId, status | Closing a cycle flips `MISSING` assets to `LOST` |
| `Notification` | userId, type, message, relatedResourceType/Id, isRead | |
| `ActivityLog` | actorId, action, resourceType, resourceId, changes (JSON) | Immutable audit trail; every mutation calls `logActivity()` |

Full schema: `prisma/schema.prisma`.

---

## API Conventions

Base URL: `/api` (Next.js route handlers under `app/api/`)

```json
// List endpoints
{ "data": [ /* ... */ ], "total": 42 }

// Errors
{ "error": "machine_readable_code", "message": "Human readable", "field": "email" }
```

Sessions use NextAuth's JWT cookie.

| Method | Route | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/auth/signup` | Public | Creates an Employee account only |
| `POST` | `/api/employees/:id/promote` | Admin | Only place a role is assigned |
| `GET`/`POST` | `/api/assets` | Asset Manager (write) | Register + search/filter |
| `POST` | `/api/allocations` | Asset Manager, Dept Head | `409` with `currentlyHeldBy` if already allocated |
| `POST` | `/api/allocations/:id/return` | Holder / Asset Manager | Marks returned, asset back to `AVAILABLE` |
| `POST` | `/api/bookings` | Any | `409` with `conflictingBooking` on overlap |
| `POST`/`PATCH` | `/api/maintenance-requests` | Any / Asset Manager | Raise + approval transitions |
| `POST` | `/api/audit-cycles` | Admin | Create cycle |
| `PATCH` | `/api/audit-cycles/:id/findings` | Auditor | Verified / Missing / Damaged |
| `POST` | `/api/audit-cycles/:id/close` | Admin | Locks cycle, Missing becomes Lost |
| `GET` | `/api/reports/*` | Admin, Managers | Utilization, maintenance frequency |

---

## User Roles

| Role | Capabilities |
|---|---|
| **Admin** | Departments, categories, audit cycles, employee/role promotion, org-wide reports |
| **Asset Manager** | Register/allocate assets, approve transfers/maintenance/audit discrepancies, approve returns |
| **Department Head** | View dept assets, approve dept allocation/transfer requests, book shared resources |
| **Employee** | View own assets, book resources, raise maintenance requests, initiate return/transfer |

---

## Screens

1. Login / Signup
2. Dashboard (KPIs, overdue highlights, quick actions)
3. Organization Setup (Departments, Categories, Employees), Admin only
4. Asset Registration & Directory (sortable table)
5. Asset Allocation & Transfer
6. Resource Booking (day grid, overlap validation)
7. Maintenance Management
8. Asset Audit (cycles, discrepancy reports)
9. Reports & Analytics
10. Activity Logs & Notifications

---

## Roadmap

Not built yet. Listed here so the scope of the current version is clear.

- [ ] Extract the API into a standalone Express/NestJS service; Next.js becomes frontend + BFF
- [ ] Refresh-token rotation, email verification, password reset
- [ ] Event-driven pipeline: Redis + BullMQ, with a worker consuming `allocation.created`, `booking.created`, `maintenance.approved`, and similar events to write notifications and activity logs asynchronously
- [ ] Scheduled overdue-return sweep as a worker job
- [ ] Real-time push (Socket.IO or SSE) replacing refetch-after-mutation
- [ ] Outbox pattern for atomic event publication
- [ ] Connection pooling (PgBouncer) for high concurrency
- [ ] Redis-backed rate limiting on auth and write routes
- [ ] Pagination on all list endpoints
- [ ] File upload for asset and maintenance photos
- [ ] Multi-auditor assignment and a manual transfer-approval step
- [ ] k6 load tests: allocation race (50 VUs on one asset) and mixed read/write load at 100 VUs

---
