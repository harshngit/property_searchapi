-- =====================================================================
-- Migration: 015_add_property_display_fields.sql
-- Project  : PropertySerch.com
-- Purpose  : The dashboard frontend (propertiesSlice.js) already reads/
--            writes these fields, but the properties table never grew
--            the columns for them - every one of them has been coming
--            back undefined. Also adds the builder-profile fields the
--            same slice reads off a property's joined builder (rating,
--            years of experience, project count).
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE properties
  ADD COLUMN about_extended     TEXT,
  ADD COLUMN carpet_area_sqft   NUMERIC(10, 2) CHECK (carpet_area_sqft IS NULL OR carpet_area_sqft >= 0),
  ADD COLUMN facing              VARCHAR(50),
  ADD COLUMN tags                JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN badge               VARCHAR(50),
  ADD COLUMN is_verified         BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN rera_number         VARCHAR(100),
  ADD COLUMN possession_status   VARCHAR(50),
  ADD COLUMN floor_number        SMALLINT,
  ADD COLUMN total_floors        SMALLINT,
  ADD COLUMN furnishing          VARCHAR(50),
  ADD COLUMN parking_spots       SMALLINT CHECK (parking_spots IS NULL OR parking_spots >= 0),
  ADD COLUMN parking_type        VARCHAR(50),
  ADD COLUMN age_of_property     VARCHAR(50),
  ADD COLUMN gated_community     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN faqs                JSONB NOT NULL DEFAULT '[]';

CREATE INDEX idx_properties_is_verified ON properties(is_verified);

-- Builder-profile fields, shown on any property joined to that builder
-- (see property.service.js's PROPERTY_SELECT) - kept on the builder's own
-- user row, not duplicated per property, since one builder has many listings.
ALTER TABLE users
  ADD COLUMN builder_rating           NUMERIC(2, 1) CHECK (builder_rating IS NULL OR (builder_rating >= 0 AND builder_rating <= 5)),
  ADD COLUMN builder_experience_years SMALLINT CHECK (builder_experience_years IS NULL OR builder_experience_years >= 0),
  ADD COLUMN builder_projects_count   SMALLINT CHECK (builder_projects_count IS NULL OR builder_projects_count >= 0);
