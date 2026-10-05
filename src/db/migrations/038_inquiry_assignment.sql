-- =====================================================================
-- Migration: 038_inquiry_assignment.sql
-- Project  : PropertySerch.com
-- Purpose  : Annexure A sec. 10 (Mandatory Intermediation) + sec. 34
--            (Universal Inquiry Assignment Cascade):
--              - arb_representatives  A R staff who take inquiries: RM / DM
--                                     / TL / TC designation, public platform
--                                     number, coverage (states, cities,
--                                     localities - all admin-editable),
--                                     team leader
--              - broker_rm_mapping    broker -> mapped RM (one-click reassign)
--              - leads.arb_rep_id     the A R representative on the inquiry
--                                     (separate from assigned_to, which stays
--                                     the broker's / agency's own workflow);
--                                     hop, window due time, route, first
--                                     contact, overall response SLA (2 h for
--                                     Exclusive Mandate, 24 h standard)
--              - lead_assignment_events  append-only: every assignment,
--                                     missed window, transfer, manual
--                                     reassignment, exit re-injection,
--                                     contact - who missed / who received
--              - deals.assigned_rep_id  the A R rep handling the deal
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE arb_representatives (
    user_id                 UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    designation             VARCHAR(5) NOT NULL DEFAULT 'rm' CHECK (designation IN ('rm', 'dm', 'tl', 'tc')),
    platform_number         VARCHAR(20),
    assigned_states         TEXT[] NOT NULL DEFAULT '{}',
    assigned_cities         TEXT[] NOT NULL DEFAULT '{}',
    coverage_localities     TEXT[] NOT NULL DEFAULT '{}',
    team_leader_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    accepts_assignments     BOOLEAN NOT NULL DEFAULT true,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_arb_representatives_updated_at
BEFORE UPDATE ON arb_representatives
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Every existing internal sales user starts as an RM with no coverage
-- (= platform-wide fallback) until an admin sets it.
INSERT INTO arb_representatives (user_id, designation)
SELECT u.id, 'rm' FROM users u JOIN roles r ON r.id = u.role_id WHERE r.name = 'internal_sales'
ON CONFLICT (user_id) DO NOTHING;

CREATE TABLE broker_rm_mapping (
    broker_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    rm_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    mapped_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    mapped_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_broker_rm_mapping_rm ON broker_rm_mapping(rm_id);

ALTER TABLE leads
    ADD COLUMN arb_rep_id              UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN assignment_hop          SMALLINT NOT NULL DEFAULT 0,
    ADD COLUMN assignment_route        VARCHAR(30),
    ADD COLUMN assigned_at             TIMESTAMPTZ,
    ADD COLUMN assignment_due_at       TIMESTAMPTZ,
    ADD COLUMN first_contacted_at      TIMESTAMPTZ,
    ADD COLUMN first_contacted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    ADD COLUMN response_sla_hours      SMALLINT,
    ADD COLUMN response_sla_due_at     TIMESTAMPTZ,
    ADD COLUMN response_sla_alerted_at TIMESTAMPTZ;

CREATE INDEX idx_leads_arb_rep ON leads(arb_rep_id);
CREATE INDEX idx_leads_assignment_due ON leads(assignment_due_at) WHERE first_contacted_at IS NULL;

CREATE TABLE lead_assignment_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id         UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    hop             SMALLINT NOT NULL,
    kind            VARCHAR(20) NOT NULL
        CHECK (kind IN ('assigned', 'missed', 'transferred', 'manual_reassign', 'exit_reinjected', 'contacted', 'mapping_gap', 'sla_breached')),
    route           VARCHAR(30),
    from_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    to_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_id        UUID REFERENCES users(id) ON DELETE SET NULL,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lead_assignment_events_lead ON lead_assignment_events(lead_id, created_at);
CREATE INDEX idx_lead_assignment_events_users ON lead_assignment_events(from_user_id, kind);

CREATE OR REPLACE FUNCTION trigger_reject_assignment_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- ON DELETE CASCADE from leads is the only permitted removal path.
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM leads WHERE id = OLD.lead_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'lead_assignment_events is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lead_assignment_events_append_only
BEFORE UPDATE OR DELETE ON lead_assignment_events
FOR EACH ROW EXECUTE FUNCTION trigger_reject_assignment_event_mutation();

-- Existing leads already contacted / worked need no cascade.
UPDATE leads SET first_contacted_at = COALESCE(updated_at, created_at)
WHERE status <> 'new' AND first_contacted_at IS NULL;
-- Existing leads already handled by A R staff keep that person as their rep.
UPDATE leads l SET arb_rep_id = l.assigned_to, assigned_at = l.created_at, assignment_hop = 1, assignment_route = 'legacy'
FROM arb_representatives ar WHERE ar.user_id = l.assigned_to AND l.arb_rep_id IS NULL;

ALTER TABLE deals ADD COLUMN assigned_rep_id UUID REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX idx_deals_assigned_rep ON deals(assigned_rep_id);
UPDATE deals d SET assigned_rep_id = l.arb_rep_id FROM leads l WHERE l.id = d.lead_id AND l.arb_rep_id IS NOT NULL;

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('assignment.response_sla_minutes', '15', 'assignment',
   'Sec. 34 - minutes per cascade hop for the assignee to log first contact before automatic transfer.'),
  ('assignment.working_hours', '{"start": "10:00", "end": "21:00", "timezone_offset_minutes": 330}', 'assignment',
   'Hop windows run only within working hours (IST); an inquiry arriving outside them gets its window from the next opening.'),
  ('assignment.max_hops', '5', 'assignment',
   'After this many hops without a logged contact the inquiry stays with its last representative and admins are alerted (no endless circling).'),
  ('assignment.sweep_seconds', '30', 'assignment',
   'How often the cascade checks for missed windows and unassigned inquiries.'),
  ('assignment.cascade_start', to_jsonb(now()), 'assignment',
   'Inquiries created before this moment are not auto-assigned by the sweep (avoids dumping the pre-launch backlog on representatives). Admin-editable.'),
  ('assignment.open_statuses', '["new", "contacted", "qualified", "hot", "warm", "cold"]', 'assignment',
   'Lead statuses that count toward a representative''s open load (least-busy ranking).')
ON CONFLICT (config_key) DO NOTHING;
