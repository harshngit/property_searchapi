-- =====================================================================
-- Migration: 024_newsletter_subscriptions.sql
-- Project  : PropertySerch.com
-- Purpose  : "Stay ahead of the market" newsletter sign-ups from the
--            website (Blogs & Insights). One row per email; re-subscribing
--            reactivates it. Listed for staff in the CRM.
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE newsletter_subscriptions (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email            VARCHAR(255) NOT NULL,
    status           VARCHAR(20) NOT NULL DEFAULT 'subscribed' CHECK (status IN ('subscribed', 'unsubscribed')),
    source_page      VARCHAR(255),
    user_id          UUID REFERENCES users(id) ON DELETE SET NULL,
    subscribed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    unsubscribed_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_newsletter_email ON newsletter_subscriptions (LOWER(email));
CREATE INDEX idx_newsletter_status ON newsletter_subscriptions (status);

CREATE TRIGGER trg_newsletter_subscriptions_updated_at
BEFORE UPDATE ON newsletter_subscriptions
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
