-- =====================================================================
-- Migration: 003_create_property_tables.sql
-- Project  : PropertySerch.com
-- Purpose  : Property Listings, Property Search, and Projects/Units
--            (Builder) module (properties, property_media, projects, units)
-- DB       : PostgreSQL
-- =====================================================================

-- ---------------------------------------------------------------------
-- ENUM TYPES
-- ---------------------------------------------------------------------
CREATE TYPE property_type AS ENUM (
    'apartment',
    'villa',
    'independent_house',
    'plot',
    'commercial',
    'farmhouse',
    'other'
);

CREATE TYPE transaction_type AS ENUM (
    'buy',
    'sell',
    'rent'
);

CREATE TYPE property_status AS ENUM (
    'draft',
    'pending_approval',
    'approved',
    'rejected',
    'inactive'
);

CREATE TYPE media_type AS ENUM (
    'image',
    'video'
);

-- NOTE: no fixed lifecycle was specified for builder projects, so a
-- reasonable standard real-estate project lifecycle is used here.
CREATE TYPE project_status AS ENUM (
    'draft',
    'upcoming',
    'ongoing',
    'completed',
    'on_hold'
);

CREATE TYPE unit_status AS ENUM (
    'available',
    'held',
    'sold'
);

-- ---------------------------------------------------------------------
-- TABLE: properties
-- Buy / sell / rent listings created by brokers, agency admins,
-- builders, or admins.
-- ---------------------------------------------------------------------
CREATE TABLE properties (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID REFERENCES tenants(id) ON DELETE SET NULL,
    created_by          UUID NOT NULL REFERENCES users(id),
    broker_id           UUID REFERENCES users(id),
    builder_id          UUID REFERENCES users(id),

    title               VARCHAR(200) NOT NULL,
    description         TEXT,
    property_type       property_type NOT NULL,
    transaction_type     transaction_type NOT NULL,

    price               NUMERIC(14, 2) NOT NULL CHECK (price >= 0),

    city                VARCHAR(100) NOT NULL,
    locality            VARCHAR(150),
    address             VARCHAR(255),
    latitude            NUMERIC(10, 7),
    longitude           NUMERIC(10, 7),

    area_sqft           NUMERIC(10, 2) CHECK (area_sqft IS NULL OR area_sqft >= 0),
    bedrooms            SMALLINT CHECK (bedrooms IS NULL OR bedrooms >= 0),
    bathrooms           SMALLINT CHECK (bathrooms IS NULL OR bathrooms >= 0),
    amenities           JSONB NOT NULL DEFAULT '[]',

    status              property_status NOT NULL DEFAULT 'draft',
    rejection_reason    TEXT,
    approved_by         UUID REFERENCES users(id),
    approved_at         TIMESTAMPTZ,

    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_properties_city              ON properties(city);
CREATE INDEX idx_properties_locality          ON properties(locality);
CREATE INDEX idx_properties_property_type     ON properties(property_type);
CREATE INDEX idx_properties_transaction_type  ON properties(transaction_type);
CREATE INDEX idx_properties_price             ON properties(price);
CREATE INDEX idx_properties_status            ON properties(status);
CREATE INDEX idx_properties_tenant_id         ON properties(tenant_id);
CREATE INDEX idx_properties_created_by        ON properties(created_by);
CREATE INDEX idx_properties_broker_id         ON properties(broker_id);
CREATE INDEX idx_properties_builder_id        ON properties(builder_id);

CREATE TRIGGER set_updated_at_properties
BEFORE UPDATE ON properties
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: property_media
-- Images / videos attached to a property listing
-- ---------------------------------------------------------------------
CREATE TABLE property_media (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    property_id     UUID NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    media_type      media_type NOT NULL DEFAULT 'image',
    url             VARCHAR(500) NOT NULL,
    display_order   SMALLINT NOT NULL DEFAULT 0,
    is_primary      BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_property_media_property_id ON property_media(property_id);

-- ---------------------------------------------------------------------
-- TABLE: projects
-- Builder projects (a project contains multiple units)
-- ---------------------------------------------------------------------
CREATE TABLE projects (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID REFERENCES tenants(id) ON DELETE SET NULL,
    builder_id      UUID NOT NULL REFERENCES users(id),

    name            VARCHAR(200) NOT NULL,
    description     TEXT,
    city            VARCHAR(100) NOT NULL,
    locality        VARCHAR(150),
    address         VARCHAR(255),

    status          project_status NOT NULL DEFAULT 'draft',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_projects_builder_id ON projects(builder_id);
CREATE INDEX idx_projects_tenant_id  ON projects(tenant_id);
CREATE INDEX idx_projects_city       ON projects(city);
CREATE INDEX idx_projects_status     ON projects(status);

CREATE TRIGGER set_updated_at_projects
BEFORE UPDATE ON projects
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();

-- ---------------------------------------------------------------------
-- TABLE: units
-- Individual units within a builder project
-- ---------------------------------------------------------------------
CREATE TABLE units (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

    unit_number     VARCHAR(50) NOT NULL,
    floor           SMALLINT,
    size            NUMERIC(10, 2) CHECK (size IS NULL OR size >= 0),
    price           NUMERIC(14, 2) NOT NULL CHECK (price >= 0),
    status          unit_status NOT NULL DEFAULT 'available',

    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_units_project_unit_number UNIQUE (project_id, unit_number)
);

CREATE INDEX idx_units_project_id ON units(project_id);
CREATE INDEX idx_units_status     ON units(status);

CREATE TRIGGER set_updated_at_units
BEFORE UPDATE ON units
FOR EACH ROW EXECUTE FUNCTION trigger_set_updated_at();
