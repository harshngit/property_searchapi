-- Section 35: User Suspension & Removal - Public Erasure Policy.
--   - 'removed' joins the user statuses ('suspended' already exists);
--   - user_suspensions is the immutable, legal-grade record of every
--     suspension, removal, reinstatement and Super Admin decision, with the
--     reasons, time and acting authority, and a snapshot of what was taken
--     out of public view;
--   - commission shares due to a suspended user are frozen until the Super
--     Admin decides;
--   - requirements hidden by a suspension wait for a fresh review on reinstatement.

ALTER TYPE user_status ADD VALUE IF NOT EXISTS 'removed';

CREATE TABLE IF NOT EXISTS user_suspensions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES users(id),
    action        VARCHAR(20) NOT NULL CHECK (action IN ('suspended', 'removed', 'reinstated', 'deal_decision', 'commission_decision', 'republished')),
    -- A reason is optional: the platform may act "without assigning any reason".
    reason        TEXT,
    internal_note TEXT,
    acted_by      UUID NOT NULL REFERENCES users(id),
    acted_role    VARCHAR(30) NOT NULL,
    acted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    snapshot      JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_user_suspensions_user ON user_suspensions (user_id, acted_at DESC);

CREATE OR REPLACE FUNCTION user_suspensions_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'user_suspensions is append-only';
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_user_suspensions_append_only ON user_suspensions;
CREATE TRIGGER trg_user_suspensions_append_only BEFORE UPDATE OR DELETE ON user_suspensions FOR EACH ROW EXECUTE FUNCTION user_suspensions_append_only();

-- A commission share (Section 14.6) held back because its person was suspended.
CREATE TABLE IF NOT EXISTS commission_freezes (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES users(id),
    commission_id   UUID NOT NULL REFERENCES franchisee_commissions(id),
    share_total     NUMERIC(14, 2) NOT NULL DEFAULT 0,
    frozen_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    decision        VARCHAR(10) CHECK (decision IN ('release', 'forfeit')),
    decided_by      UUID REFERENCES users(id),
    decided_at      TIMESTAMPTZ,
    note            TEXT,
    UNIQUE (user_id, commission_id)
);
CREATE INDEX IF NOT EXISTS idx_commission_freezes_open ON commission_freezes (commission_id) WHERE decision IS NULL;

ALTER TABLE requirements ADD COLUMN IF NOT EXISTS needs_review BOOLEAN NOT NULL DEFAULT false;
