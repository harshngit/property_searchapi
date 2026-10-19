-- Separate logins for the partner panel (Modules 24-26, sec. 33.8):
--   legal_professional  an empanelled advocate / registered valuer (LP code)
--   loan_officer        bank / NBFC partner staff (LO code)
--   insurance_officer   empanelled insurer partner staff (IO code)
-- An account is created by A R staff only after the code has been issued
-- (the enrolment / empanelment / licence check is on record). The partner
-- sees and works only the cases referred to them, never the client's phone
-- or email, and the codes stay non-commission-bearing.

INSERT INTO roles (name) VALUES ('legal_professional'), ('loan_officer'), ('insurance_officer') ON CONFLICT (name) DO NOTHING;

ALTER TABLE legal_professionals ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE partner_officers    ADD COLUMN IF NOT EXISTS user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL;

-- Billing (contract: the Legal Professional's view shows billing). The client
-- engages and pays the advocate directly; the platform only records what the
-- advocate quoted or invoiced, and takes no share.
ALTER TABLE legal_cases
  ADD COLUMN IF NOT EXISTS fee_amount NUMERIC(14,2) CHECK (fee_amount IS NULL OR fee_amount >= 0),
  ADD COLUMN IF NOT EXISTS fee_status VARCHAR(10) CHECK (fee_status IS NULL OR fee_status IN ('quoted', 'invoiced', 'paid')),
  ADD COLUMN IF NOT EXISTS fee_note   VARCHAR(300);
