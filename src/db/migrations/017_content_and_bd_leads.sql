-- =====================================================================
-- Migration: 017_content_and_bd_leads.sql
-- Project  : PropertySerch.com
-- Purpose  : Public-website content and inbound business leads:
--              - cms_articles   (Module 16 - blog / guides / reports)
--              - city_pages     (sec. 21.2 - /buy-property-in-[city] etc.
--                                rendered from CMS content, not hardcoded)
--              - bd_leads       (sec. 24 "Get Involved" + "Advertise With
--                                Us" - routed to Super Admin first, kept
--                                entirely separate from property leads)
-- DB       : PostgreSQL
-- =====================================================================

CREATE TYPE content_status AS ENUM ('draft', 'published', 'archived');

CREATE TABLE cms_articles (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                VARCHAR(200) NOT NULL UNIQUE,
    title               VARCHAR(300) NOT NULL,
    excerpt             TEXT,
    content_html        TEXT NOT NULL DEFAULT '',
    cover_image_url     VARCHAR(500),
    category            VARCHAR(100) NOT NULL DEFAULT 'blog',
    tags                JSONB NOT NULL DEFAULT '[]',
    author_name         VARCHAR(150),
    reading_minutes     SMALLINT CHECK (reading_minutes IS NULL OR reading_minutes > 0),
    seo_title           VARCHAR(300),
    seo_description     VARCHAR(500),
    schema_type         VARCHAR(50) NOT NULL DEFAULT 'Article',
    faqs                JSONB NOT NULL DEFAULT '[]',
    is_featured         BOOLEAN NOT NULL DEFAULT false,
    status              content_status NOT NULL DEFAULT 'draft',
    published_at        TIMESTAMPTZ,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_cms_articles_status_published ON cms_articles(status, published_at DESC);
CREATE INDEX idx_cms_articles_category         ON cms_articles(category);

CREATE TRIGGER set_updated_at_cms_articles
BEFORE UPDATE ON cms_articles
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- page_type drives the route family: buy/sell/rent-property-in-[city] and
-- the institutional routes (school-for-sale-[city] etc., sec. 21.4).
CREATE TABLE city_pages (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    city_id             UUID NOT NULL REFERENCES cities(id) ON DELETE CASCADE,
    slug                VARCHAR(200) NOT NULL UNIQUE,
    page_type           VARCHAR(50) NOT NULL DEFAULT 'buy'
                        CHECK (page_type IN ('buy', 'sell', 'rent', 'school_for_sale',
                                             'acquire_college', 'university_campus_for_sale')),
    title               VARCHAR(300) NOT NULL,
    hero_heading        VARCHAR(300),
    hero_subheading     TEXT,
    content_html        TEXT NOT NULL DEFAULT '',
    faqs                JSONB NOT NULL DEFAULT '[]',
    seo_title           VARCHAR(300),
    seo_description     VARCHAR(500),
    status              content_status NOT NULL DEFAULT 'draft',
    published_at        TIMESTAMPTZ,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_city_pages_city_type UNIQUE (city_id, page_type)
);

CREATE INDEX idx_city_pages_status ON city_pages(status);

CREATE TRIGGER set_updated_at_city_pages
BEFORE UPDATE ON city_pages
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: bd_leads
-- ---------------------------------------------------------------------
CREATE TYPE bd_lead_category AS ENUM (
    'city_addition',
    'careers',
    'broker',
    'builder',
    'franchisee',
    'advertiser'
);

CREATE TYPE bd_lead_status AS ENUM (
    'new',
    'under_review',
    'assigned',
    'contacted',
    'converted',
    'rejected',
    'closed'
);

CREATE TABLE bd_leads (
    id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category                bd_lead_category NOT NULL,
    full_name               VARCHAR(150) NOT NULL,
    mobile                  VARCHAR(20),
    email                   VARCHAR(150),

    city_name               VARCHAR(100),
    area_name               VARCHAR(150),
    territory_of_interest   VARCHAR(255),
    position_of_interest    VARCHAR(150),
    business_background     TEXT,
    business_name           VARCHAR(200),
    business_category       VARCHAR(100),
    desired_placement       VARCHAR(150),
    budget_range            VARCHAR(100),
    message                 TEXT,
    resume_url              VARCHAR(500),
    source_page             VARCHAR(255),

    status                  bd_lead_status NOT NULL DEFAULT 'new',
    assigned_to             UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    assigned_at             TIMESTAMPTZ,
    internal_notes          TEXT,

    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_bd_leads_contact CHECK (mobile IS NOT NULL OR email IS NOT NULL)
);

CREATE INDEX idx_bd_leads_category   ON bd_leads(category);
CREATE INDEX idx_bd_leads_status     ON bd_leads(status);
CREATE INDEX idx_bd_leads_city_name  ON bd_leads(LOWER(city_name));
CREATE INDEX idx_bd_leads_created_at ON bd_leads(created_at);

CREATE TRIGGER set_updated_at_bd_leads
BEFORE UPDATE ON bd_leads
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
