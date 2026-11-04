INSERT INTO permissions (id, code, description) VALUES
  ('10000000-0000-4000-8000-000000000028', 'reports.read', 'Consultar e exportar relatórios')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

INSERT INTO role_permission_defaults (role_code, permission_id)
SELECT role_code, permission.id
FROM (VALUES ('owner'), ('admin'), ('reception_finance')) AS allowed(role_code)
JOIN permissions permission ON permission.code = 'reports.read'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (organization_id, role_id, permission_id)
SELECT role.organization_id, role.id, permission.id
FROM roles role
JOIN permissions permission ON permission.code = 'reports.read'
WHERE role.code IN ('owner', 'admin', 'reception_finance')
ON CONFLICT DO NOTHING;

