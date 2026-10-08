-- Module 36 - In-Platform Communication Layer.
-- One conversation per enquiry (lead). The people in it are the enquirer,
-- the lister and the assigned A R Buildwel representative, who is always in
-- the thread ("rep CC'd", sec. 17.2). Nobody's phone number or email is
-- shown, and a message that tries to pass contact details is rejected
-- before it is saved and the account is flagged (sec. 10.4, 11.2).
-- Messages are append-only: all communication is logged immutably.

CREATE TABLE chat_threads (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id          UUID NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
    property_id      UUID REFERENCES properties(id) ON DELETE SET NULL,
    subject          VARCHAR(200) NOT NULL,
    status           VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    closed_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    closed_reason    VARCHAR(300),
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    last_message_at  TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE chat_participants (
    thread_id     UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- enquirer | lister | representative | staff
    party         VARCHAR(16) NOT NULL,
    last_read_id  BIGINT NOT NULL DEFAULT 0,
    joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (thread_id, user_id)
);
CREATE INDEX idx_chat_participants_user ON chat_participants(user_id);

CREATE TABLE chat_messages (
    id          BIGSERIAL PRIMARY KEY,
    thread_id   UUID NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
    sender_id   UUID REFERENCES users(id) ON DELETE SET NULL,
    party       VARCHAR(16) NOT NULL,
    kind        VARCHAR(10) NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system')),
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id, id);

CREATE OR REPLACE FUNCTION trigger_chat_messages_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'chat_messages is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chat_messages_append_only
BEFORE UPDATE ON chat_messages
FOR EACH ROW EXECUTE FUNCTION trigger_chat_messages_append_only();

-- Every look at a masked contact and every blocked message, for the audit trail.
CREATE TABLE contact_access_log (
    id          BIGSERIAL PRIMARY KEY,
    user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
    lead_id     UUID,
    action      VARCHAR(30) NOT NULL,
    detail      JSONB,
    ip_address  VARCHAR(64),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('chat.enabled', 'true', 'chat', 'Module 36 - in-platform messaging on enquiries'),
  ('chat.max_message_length', '2000', 'chat', 'Longest message allowed'),
  ('chat.blocked_attempts_to_flag', '1', 'chat', 'Blocked contact-sharing attempts before the account is flagged for staff review')
ON CONFLICT (config_key) DO NOTHING;
