-- =====================================================================
-- Migration: 007_create_payment_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : Payment Tracking module (payment_milestones, payments,
--            commission_records). Analytics & Reports is a pure
--            aggregation layer over this + existing tables - no new
--            tables needed for it.
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE milestone_status AS ENUM (
    'pending',
    'paid',
    'overdue',
    'waived'
);

CREATE TYPE payment_gateway AS ENUM (
    'razorpay',
    'payu',
    'manual'
);

CREATE TYPE payment_status AS ENUM (
    'initiated',
    'success',
    'failed',
    'refunded'
);

CREATE TYPE commission_status AS ENUM (
    'pending',
    'approved',
    'paid'
);

-- ---------------------------------------------------------------------
-- TABLE: payment_milestones
-- milestone_name is free text (e.g. 'token', 'booking', 'installment_1')
-- rather than an enum, since a deal's milestone schedule is open-ended.
-- ---------------------------------------------------------------------
CREATE TABLE payment_milestones (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,

    milestone_name  VARCHAR(100) NOT NULL,
    due_amount      NUMERIC(14, 2) NOT NULL CHECK (due_amount >= 0),
    due_date        TIMESTAMPTZ NOT NULL,
    status          milestone_status NOT NULL DEFAULT 'pending',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payment_milestones_deal_id   ON payment_milestones(deal_id);
CREATE INDEX idx_payment_milestones_status    ON payment_milestones(status);
CREATE INDEX idx_payment_milestones_tenant_id ON payment_milestones(tenant_id);

CREATE TRIGGER set_updated_at_payment_milestones
BEFORE UPDATE ON payment_milestones
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: payments
-- gateway_* columns are populated once a real gateway is integrated (see
-- TODOs in payment.service.js) - for now initiate/webhook populate them
-- with mocked/stubbed values.
-- ---------------------------------------------------------------------
CREATE TABLE payments (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             UUID REFERENCES tenants(id) ON DELETE SET NULL,
    deal_id               UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    milestone_id          UUID REFERENCES payment_milestones(id) ON DELETE SET NULL,
    customer_id           UUID NOT NULL REFERENCES customers(id),

    amount                NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    currency              VARCHAR(3) NOT NULL DEFAULT 'INR',
    gateway               payment_gateway NOT NULL DEFAULT 'manual',
    gateway_order_id      VARCHAR(255),
    gateway_payment_id    VARCHAR(255),
    gateway_signature     VARCHAR(500),
    status                payment_status NOT NULL DEFAULT 'initiated',

    initiated_by          UUID REFERENCES users(id),

    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_deal_id   ON payments(deal_id);
CREATE INDEX idx_payments_status    ON payments(status);
CREATE INDEX idx_payments_tenant_id ON payments(tenant_id);

CREATE TRIGGER set_updated_at_payments
BEFORE UPDATE ON payments
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: commission_records
-- No API endpoints create/update these in this module (none were
-- requested) - the table exists so Analytics & Reports has somewhere to
-- read commission totals from once a future module populates it.
-- ---------------------------------------------------------------------
CREATE TABLE commission_records (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    deal_id         UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    broker_id       UUID NOT NULL REFERENCES users(id),

    amount          NUMERIC(14, 2) NOT NULL CHECK (amount >= 0),
    percent         NUMERIC(5, 2),
    status          commission_status NOT NULL DEFAULT 'pending',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_commission_records_deal_id   ON commission_records(deal_id);
CREATE INDEX idx_commission_records_broker_id ON commission_records(broker_id);
