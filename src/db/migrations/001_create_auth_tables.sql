-- =====================================================================
-- Migration: 001_create_auth_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : Base tables required for Authentication & Access module
--            (tenants, roles, users, otp_verifications, refresh_tokens,
--             password_reset_tokens)
-- DB       : PostgreSQL
-- =====================================================================

-- Extension needed for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE user_status AS ENUM (
    'active',
    'pending_approval',
    'inactive',
    'suspended'
);

CREATE TYPE otp_purpose AS ENUM (
    'register',
    'login',
    'reset_password',
    'mobile_verification'
);

-- ---------------------------------------------------------------------
-- TABLE: tenants
-- Every agency / builder org operates as an isolated tenant
-- ---------------------------------------------------------------------
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            VARCHAR(150) NOT NULL,
    slug            VARCHAR(150) NOT NULL UNIQUE,
    status          VARCHAR(20)  NOT NULL DEFAULT 'active',
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- TABLE: roles
-- Fixed role catalogue used across the platform
-- ---------------------------------------------------------------------
CREATE TABLE roles (
    id              SERIAL PRIMARY KEY,
    name            VARCHAR(50) NOT NULL UNIQUE,
    description     VARCHAR(255),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO roles (name, description) VALUES
    ('customer',        'Browses properties, submits inquiries, makes payments'),
    ('broker',          'Manages assigned leads, follow-ups, shares properties'),
    ('agency_admin',    'Manages agency users, inventory, leads, broker performance'),
    ('builder',         'Manages projects, units, inventory and assigned inquiries'),
    ('internal_sales',  'Manages leads, customers, follow-ups and deal pipeline'),
    ('admin',           'Manages listings, users, approvals, reports, configuration'),
    ('super_admin',     'Full system access, tenant management, audit logs');

-- ---------------------------------------------------------------------
-- TABLE: users
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,
    role_id             INTEGER NOT NULL REFERENCES roles(id),
    full_name           VARCHAR(150) NOT NULL,
    email               VARCHAR(150) UNIQUE,
    mobile              VARCHAR(20) UNIQUE,
    password_hash       VARCHAR(255),
    status              user_status NOT NULL DEFAULT 'pending_approval',
    email_verified      BOOLEAN NOT NULL DEFAULT false,
    mobile_verified     BOOLEAN NOT NULL DEFAULT false,
    created_by          UUID REFERENCES users(id),
    last_login_at       TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_email_or_mobile CHECK (email IS NOT NULL OR mobile IS NOT NULL)
);

CREATE INDEX idx_users_tenant_id ON users(tenant_id);
CREATE INDEX idx_users_role_id   ON users(role_id);
CREATE INDEX idx_users_email     ON users(email);
CREATE INDEX idx_users_mobile    ON users(mobile);

-- ---------------------------------------------------------------------
-- TABLE: otp_verifications
-- Used for register / login / password-reset / mobile-verification OTPs
-- ---------------------------------------------------------------------
CREATE TABLE otp_verifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
    identifier      VARCHAR(150) NOT NULL,      -- email or mobile the OTP was sent to
    otp_code        VARCHAR(10)  NOT NULL,
    purpose         otp_purpose  NOT NULL,
    attempts        SMALLINT     NOT NULL DEFAULT 0,
    is_verified     BOOLEAN      NOT NULL DEFAULT false,
    expires_at      TIMESTAMPTZ  NOT NULL,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX idx_otp_identifier ON otp_verifications(identifier);
CREATE INDEX idx_otp_user_id    ON otp_verifications(user_id);

-- ---------------------------------------------------------------------
-- TABLE: refresh_tokens
-- ---------------------------------------------------------------------
CREATE TABLE refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,
    is_revoked      BOOLEAN NOT NULL DEFAULT false,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens(user_id);

-- ---------------------------------------------------------------------
-- TABLE: password_reset_tokens
-- ---------------------------------------------------------------------
CREATE TABLE password_reset_tokens (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,
    is_used         BOOLEAN NOT NULL DEFAULT false,
    expires_at      TIMESTAMPTZ NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_password_reset_user_id ON password_reset_tokens(user_id);

-- ---------------------------------------------------------------------
-- Trigger: auto-update updated_at on users / tenants
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION trigger_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at_users
BEFORE UPDATE ON users
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

CREATE TRIGGER set_updated_at_tenants
BEFORE UPDATE ON tenants
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();