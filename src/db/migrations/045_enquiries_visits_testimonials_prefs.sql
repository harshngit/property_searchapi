-- =====================================================================
-- Migration: 045_enquiries_visits_testimonials_prefs.sql
-- Project  : PropertySerch.com
-- Purpose  : UAT round 1 fixes.
--            - Enquiry type on every lead (property / home loan / insurance /
--              legal / valuation / NRI / investment / institutional / ...)
--              so the CRM shows each kind in its own tab with its own
--              columns; structured details per type.
--            - Site-visit requests from the website as their own records
--              (were only a note on the lead) with a schedule / decline flow.
--            - Testimonials managed in the CRM, shown on the home page.
--            - Notification preferences (push per topic, quiet hours).
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE leads
  ADD COLUMN enquiry_type    VARCHAR(20) NOT NULL DEFAULT 'property'
    CHECK (enquiry_type IN ('property', 'home_loan', 'insurance', 'legal', 'valuation', 'seller', 'nri', 'investment', 'institutional', 'requirement', 'general')),
  ADD COLUMN enquiry_topic   VARCHAR(150),
  ADD COLUMN enquiry_details JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX idx_leads_enquiry_type ON leads(enquiry_type, created_at DESC);

-- Existing website leads: the form topic is the "[Topic] ..." prefix of the first note.
WITH first_note AS (
  SELECT DISTINCT ON (n.lead_id) n.lead_id, substring(n.note from '^Website enquiry: \[([^\]]{1,150})\]') AS topic, n.note
  FROM lead_notes n WHERE n.note LIKE 'Website enquiry:%' ORDER BY n.lead_id, n.created_at
)
UPDATE leads l SET
  enquiry_topic = f.topic,
  enquiry_type = CASE
    WHEN f.topic ILIKE '%loan%' OR f.topic ILIKE '%financ%' THEN 'home_loan'
    WHEN f.topic ILIKE '%insurance%' THEN 'insurance'
    WHEN f.topic ILIKE '%legal%' OR f.topic ILIKE '%due diligence%' THEN 'legal'
    WHEN f.topic ILIKE '%valuation%' THEN 'valuation'
    WHEN f.topic ILIKE '%nri%' AND f.topic NOT ILIKE '%spv%' THEN 'nri'
    WHEN f.topic ILIKE '%institutional%' THEN 'institutional'
    WHEN f.topic ILIKE '%hni%' OR f.topic ILIKE '%fractional%' OR f.topic ILIKE '%spv%' OR f.topic ILIKE '%special situation%' OR f.topic ILIKE '%invest%' THEN 'investment'
    WHEN f.topic ILIKE '%seller%' OR f.topic ILIKE '%list property%' OR f.topic ILIKE '%owner services%' THEN 'seller'
    WHEN f.topic ILIKE 'requirement %' THEN 'requirement'
    WHEN l.property_id IS NOT NULL THEN 'property'
    ELSE 'general'
  END
FROM first_note f WHERE f.lead_id = l.id;

UPDATE leads SET enquiry_type = 'general' WHERE property_id IS NULL AND enquiry_type = 'property' AND enquiry_topic IS NULL AND source = 'website';

-- ------------------------------------------------------------ site-visit requests
CREATE TABLE site_visit_requests (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id        UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    customer_id    UUID REFERENCES customers(id) ON DELETE SET NULL,
    property_id    UUID REFERENCES properties(id) ON DELETE SET NULL,
    requested_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    preferred_at   TIMESTAMPTZ NOT NULL,
    note           TEXT,
    status         VARCHAR(12) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'declined', 'cancelled')),
    handled_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    handled_at     TIMESTAMPTZ,
    decline_reason TEXT,
    deal_id        UUID REFERENCES deals(id) ON DELETE SET NULL,
    site_visit_id  UUID REFERENCES site_visits(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_site_visit_requests_status ON site_visit_requests(status, preferred_at);
CREATE INDEX idx_site_visit_requests_lead ON site_visit_requests(lead_id);

-- ------------------------------------------------------------ testimonials
CREATE TABLE testimonials (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    person_name   VARCHAR(120) NOT NULL,
    person_role   VARCHAR(160),
    city          VARCHAR(120),
    quote         TEXT NOT NULL,
    rating        SMALLINT NOT NULL DEFAULT 5 CHECK (rating BETWEEN 1 AND 5),
    photo_url     VARCHAR(1000),
    is_published  BOOLEAN NOT NULL DEFAULT false,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    review_id     UUID REFERENCES reviews(id) ON DELETE SET NULL,
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_testimonials_published ON testimonials(is_published, sort_order, created_at DESC);

CREATE TRIGGER trg_testimonials_updated_at BEFORE UPDATE ON testimonials
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ------------------------------------------------------------ notification preferences
CREATE TABLE notification_preferences (
    user_id       UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    push_enabled  BOOLEAN NOT NULL DEFAULT true,
    -- topics the person does not want pushed: matches, enquiries, deals, rentals, account, updates
    push_muted    JSONB NOT NULL DEFAULT '[]'::jsonb,
    quiet_start   TIME,
    quiet_end     TIME,
    timezone      VARCHAR(60) NOT NULL DEFAULT 'Asia/Kolkata',
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
