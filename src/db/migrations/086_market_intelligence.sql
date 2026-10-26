-- Engine 6 market intelligence (Phase 1, rule-based - no paid AI).
--   area_market_snapshots  one row per city / locality / month: the platform's
--                          own prices, rents, supply and demand plus the
--                          external portal / index figures. Captured from day
--                          one so Phase 2 has the history to learn from; the
--                          price trend compares snapshots over time.
--   broker_forecasts       each broker's forecast of closures, kept per run so
--                          forecasts can later be checked against what happened.

CREATE TABLE IF NOT EXISTS area_market_snapshots (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city                  VARCHAR(120) NOT NULL,
    locality              VARCHAR(160) NOT NULL DEFAULT '',
    period                DATE NOT NULL,              -- first day of the month
    listings_sell         INT NOT NULL DEFAULT 0,
    listings_rent         INT NOT NULL DEFAULT 0,
    median_price_sqft     NUMERIC(12,2),
    median_rent_sqft      NUMERIC(10,2),
    demand_requirements   INT NOT NULL DEFAULT 0,     -- active buyer requirements (90 days)
    demand_enquiries      INT NOT NULL DEFAULT 0,     -- enquiries on listings here (90 days)
    demand_views          INT NOT NULL DEFAULT 0,     -- listing views here (90 days)
    prev_demand           INT NOT NULL DEFAULT 0,     -- the same, 91-180 days back
    deals_closed          INT NOT NULL DEFAULT 0,     -- deals closed here (180 days)
    external_price_sqft   NUMERIC(12,2),
    external_change_pct   NUMERIC(7,2),
    rental_yield_pct      NUMERIC(6,2),
    index_yoy_pct         NUMERIC(7,2),
    computed_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (city, locality, period)
);
CREATE INDEX IF NOT EXISTS idx_area_snapshots_city ON area_market_snapshots (lower(city), period DESC);

CREATE TABLE IF NOT EXISTS broker_forecasts (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    horizon_days       INT NOT NULL,
    open_deals         INT NOT NULL,
    expected_closures  NUMERIC(6,2) NOT NULL,
    expected_value     NUMERIC(16,2),
    win_rate           NUMERIC(5,2),
    band               VARCHAR(16) NOT NULL,
    reasons            JSONB NOT NULL DEFAULT '[]'::jsonb,
    computed_on        DATE NOT NULL DEFAULT CURRENT_DATE,
    UNIQUE (broker_id, computed_on, horizon_days)
);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('market_intel.weights', '{"growth": {"trend": 40, "demand_growth": 30, "demand_supply": 30}, "potential": {"growth": 40, "yield": 25, "liquidity": 20, "affordability": 15}}'::jsonb, 'market',
   'Area growth score and investment potential score weights (each set adds up to 100)'),
  ('market_intel.trend_band_percent', '3'::jsonb, 'market', 'A yearly price change above +X% is Rising, below -X% Declining, otherwise Stable'),
  ('market_intel.recommend_min_score', '70'::jsonb, 'market', 'Investment potential score from which an area is Recommended'),
  ('market_intel.min_listings', '3'::jsonb, 'market', 'Live listings an area needs (or external market data) before it is scored'),
  ('market_intel.disclaimer', '"Indicative guidance based on available platform and public market data. It is not financial advice. Consult a qualified financial professional before making investment decisions."'::jsonb, 'market',
   'Shown with every market intelligence output (non-advisory)')
ON CONFLICT (config_key) DO NOTHING;
