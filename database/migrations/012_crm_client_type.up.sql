CREATE INDEX clients_active_type_name_idx
  ON clients (organization_id, client_type, full_name, id)
  WHERE deleted_at IS NULL;
