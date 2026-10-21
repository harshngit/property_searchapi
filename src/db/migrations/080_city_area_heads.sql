-- City Head (CH) and Area Head (AH) - contract sec. 33.3 Band B employee
-- designations: a City Head holds one city on authority delegated from HQ,
-- an Area Head a locality cluster within a city. They are A R
-- representatives (internal staff) with a designation, never a user role,
-- and never take inquiries from the cascade themselves. Their scope is the
-- representative's assigned_cities (CH) and coverage_localities (AH).
-- Duties wired to them: related-party review for their city / area
-- (sec. 33.12), manual reassignment (sec. 34, with TLs), mandate renewal
-- past the cap (with the Super Admin), hop-3 / mapping-gap / related-party
-- escalation alerts.

ALTER TABLE arb_representatives DROP CONSTRAINT IF EXISTS arb_representatives_designation_check;
ALTER TABLE arb_representatives ADD CONSTRAINT arb_representatives_designation_check
  CHECK (designation IN ('rm', 'dm', 'tl', 'tc', 'fm', 'ld', 'id', 'ch', 'ah'));

-- Heads oversee; they are never routed inquiries.
CREATE OR REPLACE FUNCTION arb_heads_no_assignments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.designation IN ('ch', 'ah') THEN NEW.accepts_assignments := false; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_arb_heads_no_assignments ON arb_representatives;
CREATE TRIGGER trg_arb_heads_no_assignments BEFORE INSERT OR UPDATE OF designation, accepts_assignments ON arb_representatives FOR EACH ROW EXECUTE FUNCTION arb_heads_no_assignments();
