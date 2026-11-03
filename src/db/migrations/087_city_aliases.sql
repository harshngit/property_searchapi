-- Older or alternate city names, as data the admin can edit (no city names in
-- code - acceptance gate). Listings store the city as typed, so search and
-- chat reading both need them.
INSERT INTO app_config (config_key, value, category, description) VALUES
  ('geo.city_aliases', '{"delhi": ["new delhi"], "gurugram": ["gurgaon"], "bengaluru": ["bangalore"], "mumbai": ["bombay"], "kolkata": ["calcutta"], "chennai": ["madras"], "visakhapatnam": ["vizag"], "goa": ["panaji", "panjim"], "pune": ["poona"]}'::jsonb, 'geo',
   'Alternate names per city (lower case): official name -> other names people type')
ON CONFLICT (config_key) DO NOTHING;
