DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE ALL ON TABLE role_permission_defaults FROM clinicflow_app;
  END IF;
END;
$$;

DROP TABLE IF EXISTS role_permission_defaults;

DELETE FROM permissions
WHERE code IN (
  'organization.read', 'memberships.read', 'memberships.manage', 'roles.read',
  'roles.manage_privileged', 'schedule.read', 'schedule.own.read',
  'schedule.own.manage', 'clients.manage', 'clients.own.read', 'prospects.read',
  'prospects.manage', 'clinical.read', 'clinical.published.read', 'finance.read',
  'finance.own.read', 'fiscal.read', 'fiscal.manage', 'fiscal.own.read',
  'resources.read', 'resources.manage', 'audit.read'
);
