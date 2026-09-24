-- =====================================================================
-- Migration: 014_create_whatsapp_bot_sessions.sql
-- Project  : PropertySerch.com
-- Purpose  : Tracks an in-progress question-by-question WhatsApp bot
--            conversation per phone number (Meta's Cloud API has no
--            built-in bot/flow state - see whatsappBot.service.js).
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE whatsapp_bot_sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number    VARCHAR(20) NOT NULL UNIQUE,
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,

    current_step    VARCHAR(50) NOT NULL,
    answers          JSONB NOT NULL DEFAULT '{}',
    status           VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                     CHECK (status IN ('in_progress', 'completed')),

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_bot_sessions_phone_number ON whatsapp_bot_sessions(phone_number);

CREATE TRIGGER set_updated_at_whatsapp_bot_sessions
BEFORE UPDATE ON whatsapp_bot_sessions
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
