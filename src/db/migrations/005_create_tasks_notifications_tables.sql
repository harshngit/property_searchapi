-- =====================================================================
-- Migration: 005_create_tasks_notifications_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : Tasks & Follow-ups and Broker CRM Dashboard module
--            (tasks, notifications). The dashboard itself is a pure
--            aggregation layer over these + existing leads/properties
--            tables - no new tables are needed for it.
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE task_priority AS ENUM (
    'low',
    'medium',
    'high'
);

CREATE TYPE task_status AS ENUM (
    'pending',
    'in_progress',
    'completed',
    'overdue'
);

-- ---------------------------------------------------------------------
-- TABLE: tasks
-- related_entity_id is a plain UUID (no FK) - it can point at leads,
-- customers, deals, or properties, and the deals table doesn't exist yet.
-- ---------------------------------------------------------------------
CREATE TABLE tasks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,

    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    related_entity_type VARCHAR(50) CHECK (related_entity_type IS NULL OR related_entity_type IN ('lead', 'customer', 'deal', 'property')),
    related_entity_id   UUID,

    assigned_to         UUID REFERENCES users(id),
    created_by          UUID REFERENCES users(id),

    due_date            TIMESTAMPTZ NOT NULL,
    priority            task_priority NOT NULL DEFAULT 'medium',
    status              task_status NOT NULL DEFAULT 'pending',
    completed_at        TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX idx_tasks_status      ON tasks(status);
CREATE INDEX idx_tasks_due_date    ON tasks(due_date);
CREATE INDEX idx_tasks_tenant_id   ON tasks(tenant_id);
CREATE INDEX idx_tasks_related_entity ON tasks(related_entity_type, related_entity_id);

CREATE TRIGGER set_updated_at_tasks
BEFORE UPDATE ON tasks
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: notifications
-- `type` is intentionally a free-form VARCHAR, not an ENUM: the module
-- list (task_assigned/lead_assigned/task_overdue/follow_up_due/etc) is
-- explicitly open-ended, and new notification-producing features
-- shouldn't require a migration just to add a type value.
-- ---------------------------------------------------------------------
CREATE TABLE notifications (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,

    type                VARCHAR(50) NOT NULL,
    title               VARCHAR(200) NOT NULL,
    message             TEXT,
    related_entity_type VARCHAR(50),
    related_entity_id   UUID,

    is_read             BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_notifications_user_id ON notifications(user_id);
CREATE INDEX idx_notifications_is_read ON notifications(is_read);
