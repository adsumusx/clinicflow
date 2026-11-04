DROP INDEX client_contacts_organization_value_unique;
DROP TRIGGER client_contacts_normalize ON client_contacts;
DROP FUNCTION normalize_client_contact();
ALTER TABLE client_contacts
  DROP CONSTRAINT client_contacts_value_length,
  DROP COLUMN normalized_value;

DROP INDEX clients_active_name_idx;
DROP INDEX clients_document_normalized_unique;
ALTER TABLE clients
  DROP CONSTRAINT clients_document_normalized_format,
  DROP CONSTRAINT clients_birth_date_not_future,
  DROP CONSTRAINT clients_full_name_length,
  DROP COLUMN document_normalized;
