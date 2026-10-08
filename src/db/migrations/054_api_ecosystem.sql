-- Module 35 - API Ecosystem (sec. 17).
--   api_keys            organisation-level keys. A key acts as the account
--                       that created it (same data, never more), limited to
--                       the scopes chosen, with its own rate limit. Only a
--                       hash of the key is stored.
--   api_idempotency     Idempotency-Key replay cache (24 hours).
--   webhook_endpoints   where an organisation wants to be told about lead,
--                       deal, match, mandate and message events.
--   webhook_deliveries  one row per event per endpoint: signed, retried with
--                       back-off, kept for inspection.
--   webhook_cursors     how far the event scanner has read each source.

CREATE TABLE api_keys (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id            UUID,
    name                 VARCHAR(80) NOT NULL,
    key_prefix           VARCHAR(16) NOT NULL,
    key_hash             CHAR(64) NOT NULL UNIQUE,
    scopes               JSONB NOT NULL DEFAULT '[]',
    rate_limit_per_min   INTEGER NOT NULL DEFAULT 120,
    status               VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    expires_at           TIMESTAMPTZ,
    last_used_at         TIMESTAMPTZ,
    request_count        BIGINT NOT NULL DEFAULT 0,
    revoked_at           TIMESTAMPTZ,
    revoked_by           UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_api_keys_owner ON api_keys(owner_user_id);

CREATE TABLE api_idempotency (
    api_key_id   UUID NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
    idem_key     VARCHAR(120) NOT NULL,
    method       VARCHAR(8) NOT NULL,
    path         VARCHAR(300) NOT NULL,
    status_code  SMALLINT NOT NULL,
    response     JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (api_key_id, idem_key)
);

CREATE TABLE webhook_endpoints (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    tenant_id         UUID,
    url               VARCHAR(500) NOT NULL,
    description       VARCHAR(160),
    secret            VARCHAR(80) NOT NULL,
    events            JSONB NOT NULL DEFAULT '[]',
    status            VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
    failure_streak    INTEGER NOT NULL DEFAULT 0,
    paused_reason     VARCHAR(200),
    last_delivery_at  TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_endpoints_owner ON webhook_endpoints(owner_user_id);

CREATE TABLE webhook_deliveries (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    endpoint_id      UUID NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
    event            VARCHAR(40) NOT NULL,
    payload          JSONB NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
    attempts         SMALLINT NOT NULL DEFAULT 0,
    next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    response_code    SMALLINT,
    last_error       VARCHAR(300),
    delivered_at     TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_webhook_deliveries_due ON webhook_deliveries(next_attempt_at) WHERE status = 'pending';
CREATE INDEX idx_webhook_deliveries_endpoint ON webhook_deliveries(endpoint_id, created_at DESC);

CREATE TABLE webhook_cursors (
    source     VARCHAR(40) PRIMARY KEY,
    last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('api.enabled', 'true', 'api', 'Module 35 - public API (/api/v1) and webhooks'),
  ('api.default_rate_limit_per_min', '120', 'api', 'Requests per minute for a new API key'),
  ('api.max_keys_per_account', '5', 'api', 'Active API keys one account may hold'),
  ('api.webhook_max_attempts', '6', 'api', 'Delivery attempts before a webhook event is marked failed'),
  ('api.webhook_pause_after_failures', '20', 'api', 'Consecutive failed events after which an endpoint is paused')
ON CONFLICT (config_key) DO NOTHING;
