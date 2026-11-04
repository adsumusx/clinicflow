CREATE FUNCTION current_user_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

-- SECURITY DEFINER evita recursão da policy de memberships. A função não
-- aceita user_id do chamador: ele sempre vem do contexto autenticado da transação.
CREATE FUNCTION has_active_organization_membership(candidate_organization_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.memberships membership
    JOIN public.users app_user ON app_user.id = membership.user_id
    JOIN public.organizations organization ON organization.id = membership.organization_id
    WHERE membership.organization_id = candidate_organization_id
      AND membership.user_id = public.current_user_id()
      AND membership.status = 'active'
      AND app_user.status = 'active'
      AND organization.status = 'active'
  )
$$;

REVOKE ALL ON FUNCTION has_active_organization_membership(uuid) FROM PUBLIC;

DROP POLICY tenant_isolation ON organizations;
CREATE POLICY authenticated_tenant_isolation ON organizations
  USING (
    id = current_organization_id()
    AND has_active_organization_membership(id)
  )
  WITH CHECK (
    id = current_organization_id()
    AND has_active_organization_membership(id)
  );

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
  FOREACH table_name IN ARRAY tenant_tables LOOP
    EXECUTE format('DROP POLICY tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY authenticated_tenant_isolation ON %I USING (
         organization_id = current_organization_id()
         AND has_active_organization_membership(organization_id)
       ) WITH CHECK (
         organization_id = current_organization_id()
         AND has_active_organization_membership(organization_id)
       )',
      table_name
    );
  END LOOP;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT EXECUTE ON FUNCTION current_user_id() TO clinicflow_app;
    GRANT EXECUTE ON FUNCTION has_active_organization_membership(uuid) TO clinicflow_app;
  END IF;
END;
$$;
