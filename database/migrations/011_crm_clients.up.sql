ALTER TABLE clients
  ADD COLUMN document_normalized text,
  ADD CONSTRAINT clients_full_name_length
    CHECK (char_length(btrim(full_name)) BETWEEN 2 AND 120),
  ADD CONSTRAINT clients_birth_date_not_future
    CHECK (birth_date IS NULL OR birth_date <= CURRENT_DATE),
  ADD CONSTRAINT clients_document_normalized_format
    CHECK (document_normalized IS NULL OR document_normalized ~ '^[A-Z0-9]{5,32}$');

UPDATE clients
SET document_number = upper(regexp_replace(document_number, '[^A-Za-z0-9]', '', 'g')),
    document_normalized = upper(regexp_replace(document_number, '[^A-Za-z0-9]', '', 'g'))
WHERE document_number IS NOT NULL;

CREATE UNIQUE INDEX clients_document_normalized_unique
  ON clients (organization_id, document_normalized)
  WHERE document_normalized IS NOT NULL;

CREATE INDEX clients_active_name_idx
  ON clients (organization_id, full_name, id)
  WHERE deleted_at IS NULL;

ALTER TABLE client_contacts
  ADD COLUMN normalized_value text,
  ADD CONSTRAINT client_contacts_value_length
    CHECK (char_length(btrim(value)) BETWEEN 3 AND 160);

UPDATE client_contacts
SET normalized_value = CASE
  WHEN type = 'email' THEN lower(btrim(value))
  WHEN type = 'phone' THEN regexp_replace(value, '[^0-9]', '', 'g')
  ELSE lower(regexp_replace(btrim(value), '\s+', ' ', 'g'))
END;

ALTER TABLE client_contacts ALTER COLUMN normalized_value SET NOT NULL;

CREATE FUNCTION normalize_client_contact() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.value = btrim(NEW.value);
  NEW.normalized_value = CASE
    WHEN NEW.type = 'email' THEN lower(NEW.value)
    WHEN NEW.type = 'phone' THEN regexp_replace(NEW.value, '[^0-9]', '', 'g')
    ELSE lower(regexp_replace(NEW.value, '\s+', ' ', 'g'))
  END;
  RETURN NEW;
END;
$$;

CREATE TRIGGER client_contacts_normalize
  BEFORE INSERT OR UPDATE OF type, value, normalized_value ON client_contacts
  FOR EACH ROW EXECUTE FUNCTION normalize_client_contact();

CREATE UNIQUE INDEX client_contacts_organization_value_unique
  ON client_contacts (organization_id, type, normalized_value);
