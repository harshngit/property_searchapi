-- Module 28 - Advanced Search & Discovery (sec. 21.1).
--   Full-text   a weighted search vector on every listing (title > locality
--               / city > description) with a GIN index
--   Typo tolerance / autocomplete   trigram indexes (pg_trgm) on titles,
--               localities and cities, and a search_terms dictionary the
--               suggestions and "did you mean" read from
--   Geo-search  radius search on latitude / longitude (bounding box on an
--               index, then exact distance) - any coordinates in India
--   Ranking     trust score + verification level + recency + match score +
--               sponsored boost, weights in app_config
-- The contract names Elasticsearch for this; the same behaviour is provided
-- here by PostgreSQL so no separate search cluster has to be run.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(locality, '') || ' ' || coalesce(city, '')), 'B') ||
    setweight(to_tsvector('simple', left(coalesce(description, ''), 4000)), 'C')
) STORED;

CREATE INDEX IF NOT EXISTS idx_properties_search_vector ON properties USING GIN (search_vector);
CREATE INDEX IF NOT EXISTS idx_properties_title_trgm ON properties USING GIN (lower(title) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_properties_locality_trgm ON properties USING GIN (lower(locality) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_properties_city_trgm ON properties USING GIN (lower(city) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_properties_geo ON properties (latitude, longitude) WHERE status = 'approved' AND latitude IS NOT NULL;

-- What people can search for: cities, localities and live project names.
CREATE TABLE search_terms (
    term      VARCHAR(200) NOT NULL,
    kind      VARCHAR(10) NOT NULL CHECK (kind IN ('city', 'locality', 'project')),
    city      VARCHAR(120) NOT NULL DEFAULT '',
    listings  INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (kind, term, city)
);
CREATE INDEX idx_search_terms_trgm ON search_terms USING GIN (lower(term) gin_trgm_ops);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('search.ranking_weights', '{"trust": 1, "verification": 1, "recency": 1, "match": 1, "sponsored": 1, "text": 1}', 'search', 'Multipliers for each part of the recommended ranking (0 switches a part off)'),
  ('search.sponsored_boost', '60', 'search', 'Ranking points a live sponsored listing gets (Featured gets 20 more) before the weight is applied'),
  ('search.sponsored_max', '3', 'search', 'Most sponsored / featured listings lifted to the top of one results page'),
  ('search.recency_days', '60', 'search', 'A listing loses its recency points evenly over this many days'),
  ('search.typo_similarity', '0.35', 'search', 'How close a word must be to count as a match despite a typing mistake (0-1, higher = stricter)'),
  ('search.default_radius_km', '5', 'search', 'Radius used for a geo-search when none is given'),
  ('search.max_radius_km', '100', 'search', 'Largest radius a geo-search may ask for')
ON CONFLICT (config_key) DO NOTHING;
