-- =====================================================================
-- Migration: 021_verify_admin_listings.sql
-- Project  : PropertySerch.com
-- Purpose  : Listings created by an admin / super_admin are now approved
--            and marked verified on creation (property.service.js). Bring
--            existing admin-created listings in line: verify any that are
--            already approved, and approve + verify any still pending.
--            Imported opportunity deals (data_source crawler / csv_import /
--            api) are left as they are.
-- DB       : PostgreSQL
-- =====================================================================

UPDATE properties p
SET is_verified = true,
    status = CASE WHEN p.status = 'pending_approval' THEN 'approved'::property_status ELSE p.status END,
    approved_by = COALESCE(p.approved_by, p.created_by),
    approved_at = COALESCE(p.approved_at, now())
FROM users u
JOIN roles r ON r.id = u.role_id
WHERE u.id = p.created_by
  AND r.name IN ('admin', 'super_admin')
  AND p.data_source = 'manual'
  AND p.status IN ('approved', 'pending_approval');
