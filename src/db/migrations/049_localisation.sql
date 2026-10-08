-- Module 30 - Localization & Multi-Language (Hindi, English, regional languages).
--   languages      English is the source language; Hindi is live at launch;
--                  regional languages are listed and switched on by an admin
--                  once their translations are uploaded (no code change).
--   i18n_strings   the catalogue of interface text per app (website / crm),
--                  extracted from the code at build time.
--   translations   one row per (language, app, source text). The source
--                  text itself is the key, so a translator works from what
--                  is on screen and a missing row simply shows English.
--   users.preferred_language   follows the person across devices.

CREATE TABLE languages (
    code         VARCHAR(10) PRIMARY KEY,
    name         VARCHAR(60) NOT NULL,
    native_name  VARCHAR(60) NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT false,
    is_source    BOOLEAN NOT NULL DEFAULT false,
    sort_order   SMALLINT NOT NULL DEFAULT 0,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO languages (code, name, native_name, is_active, is_source, sort_order) VALUES
  ('en', 'English',   'English',   true,  true,  1),
  ('hi', 'Hindi',     'हिन्दी',     true,  false, 2),
  ('mr', 'Marathi',   'मराठी',      false, false, 3),
  ('gu', 'Gujarati',  'ગુજરાતી',    false, false, 4),
  ('pa', 'Punjabi',   'ਪੰਜਾਬੀ',     false, false, 5),
  ('bn', 'Bengali',   'বাংলা',      false, false, 6),
  ('ta', 'Tamil',     'தமிழ்',      false, false, 7),
  ('te', 'Telugu',    'తెలుగు',     false, false, 8),
  ('kn', 'Kannada',   'ಕನ್ನಡ',      false, false, 9),
  ('ml', 'Malayalam', 'മലയാളം',    false, false, 10),
  ('or', 'Odia',      'ଓଡ଼ିଆ',      false, false, 11);

CREATE TABLE i18n_strings (
    app          VARCHAR(10) NOT NULL CHECK (app IN ('website', 'crm')),
    source_hash  CHAR(32) NOT NULL,
    source_text  TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (app, source_hash)
);

CREATE TABLE translations (
    language_code VARCHAR(10) NOT NULL REFERENCES languages(code) ON DELETE CASCADE,
    app           VARCHAR(10) NOT NULL CHECK (app IN ('website', 'crm')),
    source_hash   CHAR(32) NOT NULL,
    source_text   TEXT NOT NULL,
    value         TEXT NOT NULL,
    -- Drafted by the AI helper and not yet checked by a person.
    is_machine    BOOLEAN NOT NULL DEFAULT false,
    updated_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (language_code, app, source_hash)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS preferred_language VARCHAR(10);
