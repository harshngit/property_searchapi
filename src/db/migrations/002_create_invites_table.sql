-- =====================================================================
-- Migration: 002_create_invites_table.sql
-- Purpose  : Supports admin/super_admin creating users for restricted
--            roles (agency_admin, builder, internal_sales, admin,
--            super_admin) via an invite-and-accept flow.
-- DB       : PostgreSQL
-- =====================================================================

CREATE TYPE invite_status AS ENUM ('pending', 'accepted', 'expired', 'revoked');

CREATE TABLE invites (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    role_id         INTEGER NOT NULL REFERENCES roles(id),
    full_name       VARCHAR(150) NOT NULL,
    email           VARCHAR(150) NOT NULL,
    invited_by      UUID NOT NULL REFERENCES users(id),
    token_hash      VARCHAR(255) NOT NULL,
    status          invite_status NOT NULL DEFAULT 'pending',
    expires_at      TIMESTAMPTZ NOT NULL,
    accepted_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_invites_email ON invites(email);
CREATE INDEX idx_invites_invited_by ON invites(invited_by);
