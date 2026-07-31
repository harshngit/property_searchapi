# PropertySerch.com — Backend API

Node.js + Express + PostgreSQL backend covering Authentication & Access,
Property Listings, Property Search, Projects/Units (Builder),
Lead Management & Customer 360, Tasks/Follow-ups & Broker CRM Dashboard,
Deal Pipeline & Document Management, and Payment Tracking & Analytics/Reports.

## Setup

```bash
cp .env.example .env      # update DB credentials & JWT secrets
npm install
npm run migrate           # runs all pending files in src/db/migrations/, tracked via schema_migrations
npm run dev                # starts on http://localhost:5000
```

Swagger UI: `http://localhost:5000/api-docs`
Raw OpenAPI JSON: `http://localhost:5000/api-docs.json`

## Endpoints implemented

| Method | Route                       | Auth required | Notes |
|--------|------------------------------|----------------|-------|
| POST   | /api/auth/register           | No  | Only `customer` and `broker` can self-register |
| POST   | /api/auth/login               | No  | Email/mobile + password |
| POST   | /api/auth/otp/send            | No  | purpose: register/login/reset_password/mobile_verification |
| POST   | /api/auth/otp/verify           | No  | Verifies OTP, issues tokens if purpose = login |
| POST   | /api/auth/refresh-token        | No  | Exchanges refresh token for new access token |
| POST   | /api/auth/logout               | Yes | Revokes the given refresh token |
| POST   | /api/auth/forgot-password       | No  | Generates reset token (email delivery not wired yet) |
| POST   | /api/auth/reset-password         | No  | Consumes reset token, sets new password |
| GET    | /api/auth/me                     | Yes | Returns logged-in user profile |
| PUT    | /api/auth/change-password         | Yes | Requires current password |
| GET    | /api/properties                    | Yes | Tenant-scoped list, filters: city, propertyType, transactionType, status, minPrice, maxPrice |
| GET    | /api/properties/:id                | Yes | 404 if outside caller's tenant/ownership (non-admin) |
| POST   | /api/properties                    | Yes | Roles: broker, agency_admin, builder, admin, super_admin. Starts as `pending_approval` |
| PUT    | /api/properties/:id                | Yes | Owner, agency_admin (same tenant), or admin/super_admin only |
| DELETE | /api/properties/:id                | Yes | Owner, agency_admin (same tenant), or admin/super_admin only |
| POST   | /api/properties/:id/media           | Yes | Accepts media URLs in body (no file upload infra yet) |
| DELETE | /api/properties/:id/media/:mediaId  | Yes | Owner/tenant manager/admin only |
| PUT    | /api/properties/:id/availability    | Yes | Toggles `approved` ↔ `inactive`; property must already be approved once |
| PUT    | /api/properties/:id/pricing         | Yes | Owner/tenant manager/admin only |
| PUT    | /api/properties/:id/approve         | Yes | admin/super_admin only |
| PUT    | /api/properties/:id/reject          | Yes | admin/super_admin only, requires `reason` in body |
| GET    | /api/properties/:id/inquiries       | Yes | Placeholder — always returns `[]`, Lead module not built yet |
| GET    | /api/search/properties             | No  | Public search, only `status = approved`. Filters: city, locality, propertyType, transactionType, minPrice, maxPrice, amenities, sort, page, limit |
| GET    | /api/search/filters                 | No  | Distinct cities, property types, transaction types, price range (for UI dropdowns) |
| GET    | /api/search/suggestions             | No  | Autocomplete on city/locality via `?q=` |
| GET    | /api/projects                      | Yes | Tenant-scoped list, filters: city, status |
| GET    | /api/projects/:id                  | Yes | 404 if outside caller's tenant/ownership (non-admin) |
| POST   | /api/projects                      | Yes | Roles: builder, admin, super_admin. Admin/super_admin must pass `builderId` |
| PUT    | /api/projects/:id                  | Yes | Project's builder or admin/super_admin only |
| GET    | /api/projects/:id/units             | Yes | Filter: status |
| POST   | /api/projects/:id/units             | Yes | Project's builder or admin/super_admin only |
| PUT    | /api/units/:id                     | Yes | Parent project's builder or admin/super_admin only |
| PUT    | /api/units/:id/status               | Yes | Parent project's builder or admin/super_admin only |
| GET    | /api/leads                         | Yes | Tenant-scoped list, filters: status, assignedTo, source, dateFrom, dateTo |
| GET    | /api/leads/:id                     | Yes | 404 if outside caller's tenant/ownership/assignment (non-admin) |
| POST   | /api/leads                         | Yes | Roles: broker, agency_admin, internal_sales, admin, super_admin. Requires an existing `customerId` |
| POST   | /api/leads/public-inquiry           | No  | Public capture endpoint, rate limited to 10 req/15min per IP. Finds-or-creates a customer by email/mobile |
| PUT    | /api/leads/:id                     | Yes | Creator, assignee, agency_admin (same tenant), or admin/super_admin only |
| PUT    | /api/leads/:id/assign               | Yes | Roles: agency_admin, internal_sales, admin, super_admin. Assignee must be in caller's tenant (unless caller is admin) |
| PUT    | /api/leads/:id/status               | Yes | Creator, assignee, agency_admin (same tenant), or admin/super_admin only. Always logged to `lead_activity_log` |
| POST   | /api/leads/:id/notes                | Yes | Creator, assignee, agency_admin (same tenant), or admin/super_admin only |
| GET    | /api/leads/:id/timeline             | Yes | Notes + activity log merged, chronological |
| GET    | /api/leads/:id/activity             | Yes | Activity log only (created, assigned, status_changed) |
| GET    | /api/customers                     | Yes | Tenant-scoped list, filter: search (name/email/mobile) |
| GET    | /api/customers/:id                 | Yes | 404 if outside caller's tenant/ownership (non-admin) |
| POST   | /api/customers                     | Yes | Roles: broker, agency_admin, internal_sales, admin, super_admin |
| PUT    | /api/customers/:id                 | Yes | Creator, agency_admin (same tenant), or admin/super_admin only |
| GET    | /api/customers/:id/preferences      | Yes | Returns `null` if never set |
| PUT    | /api/customers/:id/preferences      | Yes | Upsert (create or update) |
| GET    | /api/customers/:id/documents        | Yes | |
| POST   | /api/customers/:id/documents        | Yes | Accepts a document URL in body (no upload infra yet) |
| GET    | /api/customers/:id/conversations     | Yes | Placeholder — always returns `[]`, WhatsApp module not built yet |
| GET    | /api/customers/:id/deals            | Yes | Now queries the real `deals` table (tenant/broker-scoped), no longer a placeholder |
| GET    | /api/tasks                         | Yes | Own+created tasks (agency_admin: whole tenant; admin: all). Filters: status, priority, assignedTo, dueDateFrom, dueDateTo |
| POST   | /api/tasks                         | Yes | Roles: broker, agency_admin, internal_sales, admin, super_admin. Notifies assignee (`task_assigned`) if different from creator |
| PUT    | /api/tasks/:id                     | Yes | Creator, assignee, agency_admin (same tenant), or admin/super_admin only. Excludes status (see `/complete`); reassigning notifies the new assignee |
| PUT    | /api/tasks/:id/complete             | Yes | Same access as PUT. Sets `completed_at`; notifies creator (`task_completed`) if different from completer |
| GET    | /api/tasks/overdue                  | Yes | Scoped to caller (all for admin/super_admin). Auto-flips due tasks to `overdue` + notifies assignee (`task_overdue`) first |
| GET    | /api/tasks/today                    | Yes | Scoped to caller (all for admin/super_admin) |
| GET    | /api/followups                     | Yes | Alias over `/api/tasks` filtered to `related_entity_type = 'lead'`, sorted by due date |
| GET    | /api/notifications                  | Yes | Current user's notifications, paginated, filter: isRead |
| PUT    | /api/notifications/:id/read         | Yes | Only the owning user's notification |
| PUT    | /api/notifications/read-all         | Yes | Marks all of the current user's unread notifications as read |
| GET    | /api/broker/dashboard               | Yes | Leads-by-status, tasks due today, overdue count, properties listed, leads won this month — all for the caller |
| GET    | /api/broker/leads                   | Yes | Shortcut over `GET /api/leads` with `assignedTo` forced to the caller (reuses `lead.service.js`) |
| GET    | /api/broker/inventory                | Yes | Shortcut over `GET /api/properties` filtered to the caller as creator/broker (reuses `property.service.js`) |
| GET    | /api/broker/followups               | Yes | Caller's lead-linked tasks due today or overdue (reuses `task.service.js`) |
| GET    | /api/broker/performance-report      | Yes | Leads assigned vs. converted (won) + conversion rate for the caller; optional `from`/`to` |
| GET    | /api/deals                         | Yes | Broker-scoped list (agency_admin: whole tenant; admin: all). Filters: stage, brokerId, dateFrom, dateTo |
| GET    | /api/deals/:id                     | Yes | Includes nested `siteVisits` and `stageHistory`. 404 if outside caller's tenant/broker (non-admin) |
| POST   | /api/deals                         | Yes | Roles: broker, agency_admin, internal_sales, admin, super_admin. `leadId` auto-links customer/property/broker |
| PUT    | /api/deals/:id                     | Yes | Assigned broker, agency_admin (same tenant), or admin/super_admin only. Never changes `stage` |
| PUT    | /api/deals/:id/stage                | Yes | Validated against a fixed transition map; always logged to `deal_stage_history` in the same transaction |
| POST   | /api/deals/:id/site-visit           | Yes | Schedules a visit |
| PUT    | /api/deals/:id/site-visit/:visitId  | Yes | Updates status/notes/actual visit time |
| POST   | /api/deals/:id/negotiation           | Yes | Logs an offer/notes as a same-stage `deal_stage_history` entry — does not change `stage` |
| POST   | /api/deals/:id/booking               | Yes | Captures booking details, moves `stage` to `booking` (via the same transition-checked function) |
| PUT    | /api/deals/:id/close                | Yes | body `{ outcome: 'won'\|'lost', reason }` — sets `closed_at`, moves to `closed_won`/`closed_lost` |
| GET    | /api/documents                     | Yes | Tenant-scoped list. Filters: documentType, status, customerId, dealId |
| GET    | /api/documents/:id                 | Yes | 404 if outside caller's tenant/upload (non-admin) |
| POST   | /api/documents                     | Yes | Accepts a document URL + metadata in body (no upload infra) |
| PUT    | /api/documents/:id                 | Yes | Uploader, agency_admin (same tenant), or admin/super_admin only |
| DELETE | /api/documents/:id                 | Yes | Uploader or admin/super_admin only — no tenant-manager carve-out |
| GET    | /api/documents/customer/:customerId | Yes | Tenant-scoped |
| GET    | /api/documents/deal/:dealId         | Yes | Tenant-scoped |
| PUT    | /api/documents/:id/review           | Yes | Roles: admin, agency_admin, super_admin. body `{ status: 'approved'\|'rejected', reviewNotes }` |
| POST   | /api/payments/initiate              | Yes | Creates a `payments` row (status `initiated`); returns a **stubbed** gateway order — no live Razorpay/PayU call |
| POST   | /api/payments/webhook               | No  | Gateway webhook. Signature check is a TODO stub. Cascades success → linked milestone `paid`, in one transaction |
| GET    | /api/payments/:id                  | Yes | Tenant-scoped (via the parent deal) |
| GET    | /api/payments/deal/:dealId          | Yes | Tenant-scoped |
| GET    | /api/payments/milestones/:dealId    | Yes | Tenant-scoped |
| POST   | /api/payments/milestones            | Yes | Roles: broker, agency_admin, admin, super_admin |
| PUT    | /api/payments/milestones/:id        | Yes | Tenant-scoped (via the parent deal); no extra role gate |
| GET    | /api/reports/leads                  | Yes | Roles: admin, super_admin, agency_admin. By status/source/assignedUser. `from`/`to` |
| GET    | /api/reports/properties              | Yes | Roles: admin, super_admin, agency_admin. By status/type/transactionType + top-20 inquiries-per-listing |
| GET    | /api/reports/brokers                | Yes | Roles: admin, super_admin, agency_admin, **broker** (forced to self) |
| GET    | /api/reports/conversion             | Yes | Roles: admin, super_admin, agency_admin. Funnel: leads → site_visit → negotiation → booking → closed_won, with drop-off % |
| GET    | /api/reports/payments               | Yes | Roles: admin, super_admin, agency_admin. Collected/pending/overdue totals |
| GET    | /api/reports/revenue                 | Yes | Roles: admin, super_admin, agency_admin. Closed-won deal value + commission, by broker/agency |
| GET    | /api/reports/export                  | Yes | `?report=<type>`. Returns **CSV**, not the JSON envelope. Brokers may only export `report=brokers`, self-scoped |

## Role registration rule

Only **customer** and **broker** roles are allowed through `/api/auth/register`.
`agency_admin`, `builder`, `internal_sales`, `admin`, `super_admin` must be created
by an Admin/Super Admin via an invite flow (separate module — not part of this file set).

- customer -> status becomes `active` immediately
- broker -> status becomes `pending_approval`, needs Agency Admin/Admin to activate

## Property Listings, Search & Projects — design notes

- **Tenant isolation**: for `admin`/`super_admin`, all list/get endpoints see everything.
  For every other role, `GET /api/properties`, `GET /api/projects` (and their `:id`
  variants) are scoped to `tenant_id = caller's tenant OR created_by/builder_id =
  caller's id`. Records outside that scope 404 rather than 403, to avoid confirming
  existence to an unauthorized caller.
- **Ownership on writes**: update/delete/media/pricing/availability endpoints allow the
  creator, an `agency_admin` within the same tenant (properties only), or admin/super_admin.
  Implemented once via `src/utils/ownership.js` (`assertOwnerOrAdmin`,
  `assertTenantVisible`) rather than repeating the check per controller.
- **Availability vs. approval**: there's no separate `is_available` column — the
  `PUT /:id/availability` endpoint just toggles the existing `status` between `approved`
  and `inactive`, and only once a listing has been approved at least once. Moderation
  (`pending_approval` → `approved`/`rejected`) stays exclusively under `/approve` and
  `/reject`, which are admin/super_admin-only.
- **Project status** has no fixed set in the original spec; a standard builder lifecycle
  was used: `draft`, `upcoming`, `ongoing`, `completed`, `on_hold`.
- **Media upload** endpoints accept already-hosted URLs only — no multer/S3 upload
  middleware has been wired up (matches the ask: "don't build file upload infra unless
  I ask").

## Lead Management & Customer 360 — design notes

- **Tenant isolation** on `leads` and `customers` follows the same pattern as properties/
  projects: `admin`/`super_admin` see everything; every other role is scoped to
  `tenant_id = caller's tenant OR created_by/assigned_to = caller's id`. The ownership
  helper (`src/utils/ownership.js`) was generalized with an `ownerFields` option so leads
  can treat both `created_by` and `assigned_to` as "owner" for visibility/edit checks,
  while properties/projects keep using `created_by` only.
- **Activity log is automatic, not manual**: `lead.service.js` writes a row to
  `lead_activity_log` inside the same DB transaction as lead creation, status changes, and
  assignment changes — a controller can't create/update a lead without it being logged.
  Notes are stored separately in `lead_notes` and are not duplicated into the activity log;
  `GET /:id/timeline` merges both chronologically, `GET /:id/activity` returns the log alone.
- **`POST /api/leads` vs. `POST /api/leads/public-inquiry`**: the internal endpoint requires
  an existing `customerId` (the customer record is expected to already exist in the CRM).
  The public endpoint has no auth context, so it finds-or-creates a bare `customers` row by
  email/mobile (no `tenant_id`/`created_by`) and defaults `source` to `website`. It's rate
  limited (10 req/15 min/IP) separately from the global `/api/auth`, `/api/admin` limiter.
- **`PUT /:id/assign`** is restricted to `agency_admin`, `internal_sales`, `admin`,
  `super_admin` — brokers work leads assigned to them but don't reassign others' leads. The
  assignee must belong to the caller's tenant unless the caller is admin/super_admin.
- **Customer 360 is a staff-facing CRM module**, not a self-service portal: `customers` rows
  are independent contact records (optionally linked via `user_id` to a platform account) and
  are only created/edited by broker/agency_admin/internal_sales/admin/super_admin. No
  endpoint here lets a `customer`-role user view/edit their own record — that would need
  separate self-service auth semantics and wasn't part of this module's scope.
- **`customer_preferences`** is a 1:1 upsert (`PUT` creates or updates via
  `ON CONFLICT (customer_id)`), so `GET` returns `null` rather than 404 when preferences have
  never been set.

## Tasks/Follow-ups & Broker CRM Dashboard — design notes

- **Task scoping** is stricter than leads/properties: broker/internal_sales see only tasks
  they created or are assigned (`assigned_to = me OR created_by = me`); `agency_admin` sees
  every task in their tenant; `admin`/`super_admin` see all. This matches the brief's
  "typically only their own assigned tasks unless they're agency_admin/admin."
- **Overdue is computed lazily, not via a cron job**: every task-reading service function
  (`listTasks`, `getOverdueTasks`, `getTodayTasks`, `getFollowups`, the dashboard counts)
  first runs `syncOverdueTasks()`, which flips any `pending`/`in_progress` task whose
  `due_date` has passed to `overdue` and raises a `task_overdue` notification to its
  assignee. There's no scheduler in this stack, so "automatic" means "guaranteed fresh on
  every read" rather than "on a timer" — a real cron/queue job would be a cleaner fit later
  at higher task volume.
- **Status changes are funnelled through one endpoint**: `PUT /api/tasks/:id` intentionally
  excludes `status` — only `PUT /api/tasks/:id/complete` can complete a task, so the
  completion side effect (`completed_at`, `task_completed` notification to the creator)
  can't be bypassed. Reassignment (`assignedTo`) *is* allowed via the general `PUT`, since
  the brief gave tasks no separate `/assign` endpoint the way leads have one; reassigning
  raises `task_assigned` to the new assignee.
- **Reuse over duplication** (per the brief): `GET /api/broker/leads` and
  `/api/broker/inventory` call `lead.service.js#listLeads` / `property.service.js#listProperties`
  directly with an extra `assignedTo`/`brokerId` filter — the only new code is one small
  `brokerId` filter clause added to `listProperties` (properties had no existing "mine as
  broker" filter). Dashboard aggregate counts that don't fit a list+pagination shape
  (status breakdown, conversion rate, due-today/overdue counts) are still implemented as
  small new functions on the table-owning service (`lead.service.js#getStatusCounts`,
  `#getConversionStats`, `#getWonCount`; `task.service.js#getDashboardCounts`,
  `#getBrokerFollowups`) rather than raw SQL inside `broker.service.js`, which itself holds
  zero direct `pool.query()` calls.
- **"Leads won this month"** (dashboard) and **the performance report's conversion rate**
  answer different questions and are *not* backed by the same query: the dashboard figure
  uses `updated_at` as a proxy for "when the lead became won" (there's no `won_at` column),
  while the performance report is a cohort metric — of leads *created* in the given
  `from`/`to` window, how many have since converted. Mixing the two would have quietly
  produced a wrong number, so they're two separate functions in `lead.service.js`.
- **`notifications.type`** is a free-form `VARCHAR`, not a Postgres enum — the brief's own
  list ("task_assigned/lead_assigned/task_overdue/follow_up_due/etc") is explicitly
  open-ended, and a new notification-producing feature shouldn't require a migration just
  to add a type string. `lead_assigned`/`follow_up_due` are defined in the schema's intent
  but nothing in this module emits them yet — no lead-assignment or generic follow-up
  reminder hook currently calls `notification.service.js#createNotification` for those; that
  wiring belongs to whichever future feature needs it (e.g. `lead.service.js#assignLead`
  could easily raise `lead_assigned` the same way tasks do).

## Deal Pipeline & Document Management — design notes

- **`deals` has no `created_by`** by design (matching the spec's exact field list) —
  `broker_id` is the single ownership field, so `assertOwnerOrAdmin`/`assertTenantVisible`
  are called with `ownerFields: ['broker_id']` throughout `deal.controller.js`.
- **Every stage-affecting endpoint shares one transactional function**:
  `deal.service.js#changeStage(id, toStage, user, notes)` row-locks the deal
  (`SELECT ... FOR UPDATE`), validates the transition against `STAGE_TRANSITIONS`, updates
  `stage` (and `closed_at` when landing on a terminal stage), and writes to
  `deal_stage_history` — all in one transaction. `PUT /:id/stage`, `POST /:id/booking`, and
  `PUT /:id/close` all call it directly; nothing updates `deals.stage` any other way.
- **The transition map is intentionally linear-with-exits**:
  `inquiry → site_visit → negotiation → booking → documentation → payment → closed_won`,
  with every non-terminal stage also allowed to go to `on_hold` or `closed_lost`, and
  `on_hold` allowed back into any active stage or `closed_lost`. `closed_won` is only
  reachable from `payment` — e.g. `inquiry → closed_won` is rejected with a 400 listing the
  actually-allowed next stages.
- **`POST /:id/negotiation` deliberately does not change stage** — `changeStage` treats
  `toStage === fromStage` as always allowed (no transition-map lookup needed), so logging an
  offer/counter-offer just appends a same-stage `deal_stage_history` row. Moving the deal
  into/out of the `negotiation` stage itself still goes through `PUT /:id/stage`.
- **Two parallel document tables exist on purpose**: `customer_documents` (from the Customer
  360 module, migration 004) is unchanged and still backs
  `GET/POST /api/customers/:id/documents`. The new `documents` table (migration 006) is a
  more general, deal-aware store with `tenant_id`, `file_name`, and a reviewer workflow
  (`reviewed_by`/`review_notes`), reused by the standalone `/api/documents/*` endpoints. They
  were kept separate rather than migrating the older endpoints onto the new table, since that
  wasn't part of this module's requested scope — flagged below as a candidate for later
  consolidation.
- **`GET /api/customers/:id/deals`** now queries `deals` directly with inline tenant/broker
  scoping (not by importing `deal.service.js`), to avoid a circular require:
  `deal.service.js → lead.service.js → customer.service.js`.
- **`GET /api/properties/:id/inquiries`** was left untouched per instructions — it's still
  the pre-existing empty-array placeholder from the Property module; verified via smoke test
  that it still returns 200 and hasn't regressed.

## Payment Tracking & Analytics/Reports — design notes

- **No live gateway integration, by design** — `payment.service.js#initiatePayment` inserts
  a `payments` row (`status='initiated'`) and returns a stubbed order payload
  (`stub_order_<random>`, `keyId: 'stub_key_id'`); `#handleWebhook` only checks that a
  `gatewaySignature` was *present*, not that it's valid. Both have inline `TODO` comments
  showing exactly where a real Razorpay `orders.create()` call / HMAC signature
  verification would go. No real credentials or SDK calls exist anywhere in this module.
- **The payment → milestone cascade is one transaction**: `handleWebhook` row-locks the
  payment by `gateway_order_id` (`FOR UPDATE`), updates its `status`/`gateway_payment_id`/
  `gateway_signature`, and — only when the new status is `success` and the payment has a
  `milestone_id` — updates that milestone to `status='paid'`, all inside a single
  `BEGIN`/`COMMIT`. A failed/refunded webhook never touches the milestone. Verified live: see
  the smoke test that initiated a payment, fired a `status: 'success'` webhook, and confirmed
  both the payment and its linked milestone flipped in the same call.
- **`commission_records` has no write endpoints in this module** — the spec's Payment
  Tracking API section never asked for one, so nothing populates it yet. `GET
  /api/reports/revenue`'s `totalCommission`/`commissionByBroker` will read `0` until a future
  module (deal-closing commission calculation, presumably) starts inserting rows.
- **Milestone `overdue` status is manual**, unlike task overdue-detection — nothing
  auto-flips a `payment_milestones` row past its `due_date` to `overdue`. This wasn't
  requested for this module (contrast with Tasks' lazy `syncOverdueTasks()`); `PUT
  /milestones/:id` accepts `status: 'overdue'` explicitly if a caller wants to set it.
- **Reports use two different tenant-scoping shapes**: most reports filter their own table's
  `tenant_id` directly, but the conversion funnel's `deal_stage_history` has no `tenant_id`
  column, so it's scoped by joining to `deals` (`d.tenant_id`) instead — see
  `report.service.js#getConversionFunnel`.
- **The conversion funnel counts deals that ever reached a stage**, not deals currently
  sitting there — each stage's count is `COUNT(DISTINCT deal_id)` from
  `deal_stage_history WHERE to_stage = <stage>`, so a deal that's now `closed_lost` still
  counts toward every stage it passed through on the way. `leads` (the top of the funnel)
  comes from the `leads` table directly, since a lead can exist with no deal yet.
- **`GET /api/reports/brokers` and `GET /api/reports/export?report=brokers`** are the two
  report endpoints a `broker` role may call — the route's `authorize()` allows it, and the
  controller then force-overrides `brokerId` to the caller's own id regardless of what's in
  the query string, so a broker can never read another broker's numbers. Exporting any other
  `report` type as a broker returns 403.
- **CSV export is generic, not per-report**: `GET /api/reports/export` calls the same report
  generator functions used by the JSON endpoints, then flattens the (possibly nested) result
  into `metric,value` rows via `src/utils/csv.js#flattenToRows` (e.g. `byStatus.new,5`). This
  trades a bespoke tabular CSV shape per report for one small, reusable utility with zero
  external dependencies — matching the "simple manual CSV-writer" ask. It's the one endpoint
  in this module that doesn't use `success()`/`error()`, since it streams `text/csv` with a
  `Content-Disposition: attachment` header instead of a JSON envelope.

## Not yet wired (TODO — next modules)

- Actual SMS/Email provider integration for OTP & reset link delivery (currently returned
  in the API response only when `NODE_ENV !== production`, for local testing)
- Tenant onboarding APIs
- File upload infrastructure for property/customer/deal document media (currently URL-only)
- WhatsApp module (`GET /api/customers/:id/conversations` is a placeholder)
- A real scheduled job for overdue-task detection/notification (currently computed lazily on
  read — see Tasks design notes above) and for `lead_assigned`/`follow_up_due` notifications
- `GET /api/properties/:id/inquiries` could now be implemented for real (leads have a
  `property_id` link) — left as a placeholder since it was explicitly out of scope this round
- Consider consolidating `customer_documents` into the newer, more capable `documents` table
  (see design notes above) once that migration is worth the churn
- Real Razorpay/PayU SDK integration (order creation + webhook signature verification) —
  see the `TODO` comments in `payment.service.js`
- A commission-calculation hook that actually inserts into `commission_records` (e.g. when a
  deal closes `closed_won`), so `GET /api/reports/revenue`'s commission figures aren't always 0
- Automatic overdue detection for `payment_milestones` (currently manual), mirroring the
  Tasks module's lazy `syncOverdueTasks()` pattern
