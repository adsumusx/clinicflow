DO $$
DECLARE table_name text;
DECLARE tenant_tables text[] := ARRAY[
  'units','roles','role_permissions','memberships','professionals',
  'clients','client_contacts','client_consents','clinical_records','assessments','workout_plans','prospects','prospect_interactions',
  'modalities','services','rooms','equipment','availability_rules','recurrence_rules','appointments','appointment_participants',
  'appointment_equipment','checkins','waitlist_entries','waitlist_offers','replacement_credits',
  'plans','contracts','financial_categories','receivables','payables','payments','fiscal_documents','fiscal_attempts','fiscal_events',
  'files','file_links','notification_preferences','notifications','outbox_events','audit_events'
];
BEGIN
  DROP POLICY authenticated_tenant_isolation ON organizations;
  CREATE POLICY tenant_isolation ON organizations
    USING (id = current_organization_id()) WITH CHECK (id = current_organization_id());

  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY authenticated_tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_organization_id()) WITH CHECK (organization_id = current_organization_id())',
      table_name
    );
  END LOOP;
END;
$$;

DROP FUNCTION IF EXISTS has_active_organization_membership(uuid);
DROP FUNCTION IF EXISTS current_user_id();
