ALTER TABLE prospects
  ADD COLUMN next_action_note text,
  ADD COLUMN converted_at timestamptz,
  ADD CONSTRAINT prospects_full_name_length
    CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 120),
  ADD CONSTRAINT prospects_source_length
    CHECK (source IS NULL OR char_length(btrim(source)) BETWEEN 2 AND 80),
  ADD CONSTRAINT prospects_next_action_note_length
    CHECK (next_action_note IS NULL OR char_length(btrim(next_action_note)) BETWEEN 2 AND 240);

UPDATE prospects
SET stage = 'converted', converted_at = updated_at
WHERE converted_client_id IS NOT NULL;

UPDATE prospects
SET stage = 'new'
WHERE converted_client_id IS NULL
  AND stage NOT IN ('new', 'contacted', 'qualified', 'proposal', 'lost');

UPDATE prospects
SET source = 'Não informada'
WHERE source IS NULL OR char_length(btrim(source)) < 2;

ALTER TABLE prospects
  ALTER COLUMN source SET NOT NULL,
  ADD CONSTRAINT prospects_stage_valid
    CHECK (stage IN ('new', 'contacted', 'qualified', 'proposal', 'lost', 'converted')),
  ADD CONSTRAINT prospects_conversion_consistent
    CHECK ((stage = 'converted') = (converted_client_id IS NOT NULL AND converted_at IS NOT NULL));

CREATE TABLE prospect_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL,
  prospect_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('email', 'phone', 'other')),
  value text NOT NULL,
  normalized_value text NOT NULL,
  preferred boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, prospect_id, type, normalized_value),
  CONSTRAINT prospect_contacts_value_length CHECK (char_length(btrim(value)) BETWEEN 3 AND 160),
  FOREIGN KEY (organization_id, prospect_id)
    REFERENCES prospects(organization_id, id) ON DELETE CASCADE
);

INSERT INTO prospect_contacts (organization_id, prospect_id, type, value, normalized_value, preferred)
SELECT organization_id, id, 'other', btrim(contact), lower(regexp_replace(btrim(contact), '\s+', ' ', 'g')), true
FROM prospects
WHERE contact IS NOT NULL AND char_length(btrim(contact)) BETWEEN 3 AND 160;

CREATE TRIGGER prospect_contacts_normalize
  BEFORE INSERT OR UPDATE OF type, value, normalized_value ON prospect_contacts
  FOR EACH ROW EXECUTE FUNCTION normalize_client_contact();

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON prospect_contacts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE UNIQUE INDEX prospect_contacts_one_preferred_type
  ON prospect_contacts(organization_id, prospect_id, type) WHERE preferred;
CREATE INDEX prospects_funnel_idx
  ON prospects(organization_id, stage, next_action_at, created_at DESC);
CREATE INDEX prospects_search_name_idx
  ON prospects(organization_id, lower(full_name) text_pattern_ops, id);
CREATE INDEX prospect_contacts_search_value_idx
  ON prospect_contacts(organization_id, normalized_value text_pattern_ops, prospect_id);
CREATE INDEX prospect_interactions_timeline_idx
  ON prospect_interactions(organization_id, prospect_id, occurred_at DESC, id DESC);

ALTER TABLE prospect_interactions
  ADD CONSTRAINT prospect_interactions_type_valid
    CHECK (type IN ('call', 'email', 'message', 'meeting', 'note', 'stage_change', 'conversion')),
  ADD CONSTRAINT prospect_interactions_notes_length
    CHECK (notes IS NULL OR char_length(btrim(notes)) BETWEEN 2 AND 2000);

ALTER TABLE prospect_contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE prospect_contacts FORCE ROW LEVEL SECURITY;
CREATE POLICY authenticated_tenant_isolation ON prospect_contacts
  USING (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  )
  WITH CHECK (
    organization_id = current_organization_id()
    AND has_active_organization_membership(organization_id)
  );

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE prospect_contacts TO clinicflow_app;
  END IF;
END;
$$;
