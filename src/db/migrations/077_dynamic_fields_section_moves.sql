-- Dynamic Field Manager, part 4: a built-in field can move to another section
-- of its own form. default_section remembers where the form put it, so the
-- forms know to place it elsewhere and the Super Admin can put it back.

ALTER TABLE metadata_fields ADD COLUMN IF NOT EXISTS default_section VARCHAR(80);

UPDATE metadata_fields SET default_section = section WHERE is_system AND default_section IS NULL;
