CREATE INDEX clients_active_search_name_idx
  ON clients (organization_id, lower(full_name) text_pattern_ops, id)
  WHERE deleted_at IS NULL;

CREATE INDEX client_contacts_search_value_idx
  ON client_contacts (organization_id, normalized_value text_pattern_ops, client_id);

CREATE INDEX contracts_client_timeline_idx
  ON contracts (organization_id, client_id, starts_on DESC, id DESC);

CREATE INDEX receivables_client_timeline_idx
  ON receivables (organization_id, client_id, due_on DESC, id DESC);

CREATE INDEX audit_events_target_timeline_idx
  ON audit_events (organization_id, target_type, target_id, occurred_at DESC, id DESC);
