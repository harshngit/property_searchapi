-- =====================================================================
-- Migration: 026_deal_room.sql
-- Project  : PropertySerch.com
-- Purpose  : Module 39 - Advanced Deal Room / Data Room. NDA-gated,
--            versioned document sharing for special situation deals
--            (SARFAESI auction documents, legal notices, EMD receipts),
--            institutional deals and HNI transactions (term sheets,
--            financials). Sits on top of the document storage (Module 20).
--
--            A document is visible only when ALL three hold (Annexure A):
--              1. verified buyer (verified NRI/HNI investor profile or an
--                 active broker),
--              2. NDA signed on the platform,
--              3. admin approval of the access request.
--            Buyers only ever see the latest APPROVED version. Every view,
--            download, blocked download and URL generation is logged in an
--            append-only access log.
-- DB       : PostgreSQL
-- =====================================================================

CREATE TABLE deal_room_documents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    title               VARCHAR(200) NOT NULL,
    document_type       VARCHAR(40) NOT NULL DEFAULT 'other'
        CHECK (document_type IN ('auction_notice', 'sale_notice', 'emd_receipt', 'title_documents', 'valuation_report',
                                 'legal_opinion', 'inspection_report', 'term_sheet', 'financials', 'photos', 'other')),
    description         TEXT,
    download_allowed    BOOLEAN NOT NULL DEFAULT false,
    watermark           BOOLEAN NOT NULL DEFAULT true,
    expires_at          TIMESTAMPTZ,
    is_active           BOOLEAN NOT NULL DEFAULT true,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deal_room_documents_property ON deal_room_documents(property_id);

CREATE TRIGGER trg_deal_room_documents_updated_at
BEFORE UPDATE ON deal_room_documents
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Every upload is a new version; older versions are retained for staff.
CREATE TABLE deal_room_document_versions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id     UUID NOT NULL REFERENCES deal_room_documents(id) ON DELETE CASCADE,
    version         INT NOT NULL,
    object_path     VARCHAR(500) NOT NULL,
    file_name       VARCHAR(255),
    mime_type       VARCHAR(120),
    size_bytes      BIGINT,
    status          VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
    notes           TEXT,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_deal_room_version UNIQUE (document_id, version)
);

-- One access record per user per deal: NDA signature + admin decision.
CREATE TABLE deal_room_access (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    investor_profile_id UUID REFERENCES investor_profiles(id) ON DELETE SET NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'pending_approval'
        CHECK (status IN ('pending_approval', 'approved', 'rejected', 'revoked')),
    nda_version         VARCHAR(20) NOT NULL,
    nda_signed_name     VARCHAR(150) NOT NULL,
    nda_signed_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    nda_ip              VARCHAR(64),
    nda_user_agent      VARCHAR(500),
    decided_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    decided_at          TIMESTAMPTZ,
    decision_reason     TEXT,
    access_expires_at   TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_deal_room_access UNIQUE (property_id, user_id)
);

CREATE INDEX idx_deal_room_access_status ON deal_room_access(status);

CREATE TRIGGER trg_deal_room_access_updated_at
BEFORE UPDATE ON deal_room_access
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- Append-only: every view / download / blocked download / URL generation /
-- NDA signature / access decision.
CREATE TABLE deal_room_access_log (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id         UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    document_id         UUID REFERENCES deal_room_documents(id) ON DELETE SET NULL,
    version_id          UUID REFERENCES deal_room_document_versions(id) ON DELETE SET NULL,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    action              VARCHAR(30) NOT NULL
        CHECK (action IN ('viewed', 'downloaded', 'download_blocked', 'url_generated', 'nda_signed',
                          'access_approved', 'access_rejected', 'access_revoked', 'uploaded', 'version_approved')),
    ip_address          VARCHAR(64),
    user_agent          VARCHAR(500),
    device_fingerprint  VARCHAR(128),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_deal_room_log_property ON deal_room_access_log(property_id, created_at DESC);

CREATE OR REPLACE FUNCTION trigger_reject_deal_room_log_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'deal_room_access_log is append-only: % is not permitted', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER deal_room_access_log_append_only
BEFORE UPDATE OR DELETE ON deal_room_access_log
FOR EACH ROW EXECUTE FUNCTION trigger_reject_deal_room_log_mutation();

INSERT INTO app_config (config_key, value, category, description) VALUES
  ('deal_room.presigned_url_ttl_minutes', '15', 'deal_room',
   'Minutes a deal-room document link stays valid (Module 39 default 15).'),
  ('deal_room.access_validity_days', '90', 'deal_room',
   'Days an approved deal-room access lasts before it must be re-approved. 0 = no expiry.'),
  ('deal_room.nda', '{"version": "1.0", "title": "Confidentiality Undertaking", "text": "I agree to keep every document, figure and detail I see in this deal room strictly confidential. I will use it only to evaluate this opportunity, will not share, copy or publish it, and will not contact the seller, borrower, lender or any other party directly - all communication goes through my A R Buildwel representative. I understand my access is logged and may be revoked at any time, and that documents are provided for information only and must be independently verified before I act on them."}', 'deal_room',
   'NDA shown and signed (typed name) before a deal room can be requested. Bump version when the text changes.')
ON CONFLICT (config_key) DO NOTHING;
