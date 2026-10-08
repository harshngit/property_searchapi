-- Module 45 - Property Exchange Engine ("exchange your old or stuck-up
-- property for a new one"). Seated inside Engine 5: it reuses listings,
-- market valuation inputs, special-situation inventory and the Module 40
-- deal pipeline - an exchange is two ordinary deals linked to each other.
--   Model A  direct swap   two owners exchange; the value difference is
--                          settled between them off-platform
--   Model B  trade-in      the old property's assessed value goes toward a
--                          new unit from builder / A R Buildwel stock
-- Professional fee is 1% + GST on EACH leg, on the usual two instalments -
-- which is exactly what Module 40 already does per deal.

ALTER TABLE properties   ADD COLUMN IF NOT EXISTS exchange_intent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE requirements ADD COLUMN IF NOT EXISTS exchange_intent BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS linked_deal_id UUID REFERENCES deals(id) ON DELETE SET NULL;
ALTER TABLE deals ADD COLUMN IF NOT EXISTS exchange_request_id UUID;

CREATE SEQUENCE exchange_request_seq START 1;

CREATE TABLE exchange_requests (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number          VARCHAR(20) NOT NULL UNIQUE,
    owner_user_id           UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
    old_property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    -- Set when an option is chosen: direct_swap | trade_in (sec. B.9 enum).
    exchange_type           VARCHAR(12) CHECK (exchange_type IN ('direct_swap', 'trade_in')),
    -- The reinvestment questionnaire.
    reinvestment_intent     VARCHAR(20) NOT NULL DEFAULT 'guidance' CHECK (reinvestment_intent IN ('buy_another', 'invest_auction', 'downsize', 'direct_swap', 'guidance')),
    -- What they want instead.
    wanted_city             VARCHAR(120),
    wanted_localities       JSONB NOT NULL DEFAULT '[]',
    wanted_property_type    VARCHAR(40),
    wanted_bedrooms_min     SMALLINT,
    wanted_budget_max       NUMERIC(16,2),
    notes                   TEXT,
    -- Indicative valuation of the old property.
    old_property_valuation  NUMERIC(16,2),
    valuation_source        VARCHAR(12) CHECK (valuation_source IN ('platform', 'asking', 'admin')),
    valuation_basis         JSONB,
    valued_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    valued_at               TIMESTAMPTZ,
    -- The chosen option.
    new_target_reference    UUID REFERENCES properties(id) ON DELETE SET NULL,
    counterparty_request_id UUID REFERENCES exchange_requests(id) ON DELETE SET NULL,
    target_value            NUMERIC(16,2),
    value_difference        NUMERIC(16,2),
    assigned_rep_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    status                  VARCHAR(16) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'option_chosen', 'in_progress', 'closed', 'cancelled')),
    status_note             TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_exchange_open_property ON exchange_requests(old_property_id) WHERE status IN ('open', 'option_chosen', 'in_progress');
CREATE INDEX idx_exchange_owner ON exchange_requests(owner_user_id);
CREATE INDEX idx_exchange_status ON exchange_requests(status, created_at DESC);

ALTER TABLE deals ADD CONSTRAINT fk_deals_exchange_request FOREIGN KEY (exchange_request_id) REFERENCES exchange_requests(id) ON DELETE SET NULL;

-- An owner's interest in one of the options shown to them.
CREATE TABLE exchange_interests (
    id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id               UUID NOT NULL REFERENCES exchange_requests(id) ON DELETE CASCADE,
    option_kind              VARCHAR(20) NOT NULL CHECK (option_kind IN ('direct_swap', 'trade_in', 'upgrade', 'special_situation', 'downsize', 'hold_and_rent')),
    target_property_id       UUID REFERENCES properties(id) ON DELETE CASCADE,
    counterparty_request_id  UUID REFERENCES exchange_requests(id) ON DELETE CASCADE,
    target_value             NUMERIC(16,2),
    value_difference         NUMERIC(16,2),
    status                   VARCHAR(12) NOT NULL DEFAULT 'interested' CHECK (status IN ('interested', 'confirmed', 'declined', 'withdrawn')),
    note                     TEXT,
    decided_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at               TIMESTAMPTZ,
    created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_exchange_interests_request ON exchange_interests(request_id);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('exchange.enabled', 'true', 'exchange', 'Module 45 - property exchange (direct swap and trade-in)'),
  ('exchange.value_tolerance_percent', '25', 'exchange', 'Direct swap: how far apart the two properties'' values may be, as a percent of the higher one'),
  ('exchange.hold_and_rent_after_days', '90', 'exchange', 'Suggest renting instead once a sale listing has been live this many days without a deal'),
  ('exchange.downsize_max_percent', '70', 'exchange', 'Downsizing options cost at most this percent of the old property''s value'),
  ('exchange.valuation_disclaimer', '"Indicative valuation based on available platform data. It is not a formal valuation. Verify independently before transacting."', 'exchange', 'Shown with every exchange valuation'),
  ('exchange.guidance_disclaimer', '"This is indicative guidance based on available platform data. It is not financial advice. Consult a qualified financial advisor and legal counsel before transacting."', 'exchange', 'Shown with all reinvestment guidance (sec. B.9)')
ON CONFLICT (config_key) DO NOTHING;
