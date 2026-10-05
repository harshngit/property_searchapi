-- =====================================================================
-- Migration: 043_guest_interest_enum.sql
-- Project  : PropertySerch.com
-- Purpose  : Guest Interest (no registration) - OTP purpose for the
--            mobile + OTP check. Enum value only (used from 044 on).
-- DB       : PostgreSQL
-- =====================================================================
ALTER TYPE otp_purpose ADD VALUE IF NOT EXISTS 'guest_interest';
