# PropertySerch.com — Backend API

Node.js + Express + PostgreSQL backend covering Authentication & Access,
Property Listings, Property Search, and Projects/Units (Builder).

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

## Not yet wired (TODO — next modules)

- Actual SMS/Email provider integration for OTP & reset link delivery (currently returned
  in the API response only when `NODE_ENV !== production`, for local testing)
- Tenant onboarding APIs
- File upload infrastructure for property media (currently URL-only)
- Lead/Inquiry module (`GET /api/properties/:id/inquiries` is a placeholder)
