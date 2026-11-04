ALTER TABLE clinical_records
  ADD COLUMN IF NOT EXISTS professional_registration text;
