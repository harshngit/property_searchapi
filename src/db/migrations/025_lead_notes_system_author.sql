-- =====================================================================
-- Migration: 025_lead_notes_system_author.sql
-- Project  : PropertySerch.com
-- Purpose  : Allow lead notes written by the system rather than a user -
--            the message a visitor types into a website form is saved as
--            the first note on their lead (no logged-in author).
-- DB       : PostgreSQL
-- =====================================================================

ALTER TABLE lead_notes ALTER COLUMN user_id DROP NOT NULL;
