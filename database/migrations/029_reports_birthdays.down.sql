DELETE FROM role_permissions
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'reports.read');

DELETE FROM role_permission_defaults
WHERE permission_id = (SELECT id FROM permissions WHERE code = 'reports.read');

DELETE FROM permissions WHERE code = 'reports.read';

