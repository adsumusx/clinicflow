-- Catálogo global de capacidades. A aplicação autoriza pelo código da
-- permissão, nunca pelo nome do papel.
INSERT INTO permissions (id, code, description) VALUES
  ('10000000-0000-4000-8000-000000000001', 'organization.manage', 'Alterar configurações da organização'),
  ('10000000-0000-4000-8000-000000000002', 'schedule.manage', 'Criar e alterar agendas'),
  ('10000000-0000-4000-8000-000000000003', 'clients.read', 'Consultar cadastros de clientes permitidos'),
  ('10000000-0000-4000-8000-000000000004', 'finance.manage', 'Criar e alterar dados financeiros'),
  ('10000000-0000-4000-8000-000000000005', 'clinical.write', 'Registrar conteúdo clínico permitido'),
  ('10000000-0000-4000-8000-000000000006', 'organization.read', 'Consultar configurações da organização'),
  ('10000000-0000-4000-8000-000000000007', 'memberships.read', 'Consultar vínculos da organização'),
  ('10000000-0000-4000-8000-000000000008', 'memberships.manage', 'Convidar e revogar vínculos não privilegiados'),
  ('10000000-0000-4000-8000-000000000009', 'roles.read', 'Consultar funções e permissões'),
  ('10000000-0000-4000-8000-000000000010', 'roles.manage_privileged', 'Atribuir ou revogar funções privilegiadas'),
  ('10000000-0000-4000-8000-000000000011', 'schedule.read', 'Consultar a agenda da equipe permitida'),
  ('10000000-0000-4000-8000-000000000012', 'schedule.own.read', 'Consultar a própria agenda'),
  ('10000000-0000-4000-8000-000000000013', 'schedule.own.manage', 'Gerenciar os próprios agendamentos'),
  ('10000000-0000-4000-8000-000000000014', 'clients.manage', 'Criar e alterar cadastros de clientes'),
  ('10000000-0000-4000-8000-000000000015', 'clients.own.read', 'Consultar o próprio cadastro'),
  ('10000000-0000-4000-8000-000000000016', 'prospects.read', 'Consultar prospecções permitidas'),
  ('10000000-0000-4000-8000-000000000017', 'prospects.manage', 'Criar e alterar prospecções'),
  ('10000000-0000-4000-8000-000000000018', 'clinical.read', 'Consultar conteúdo clínico permitido'),
  ('10000000-0000-4000-8000-000000000019', 'clinical.published.read', 'Consultar conteúdo clínico próprio publicado'),
  ('10000000-0000-4000-8000-000000000020', 'finance.read', 'Consultar dados financeiros'),
  ('10000000-0000-4000-8000-000000000021', 'finance.own.read', 'Consultar as próprias faturas'),
  ('10000000-0000-4000-8000-000000000022', 'fiscal.read', 'Consultar documentos fiscais'),
  ('10000000-0000-4000-8000-000000000023', 'fiscal.manage', 'Emitir e gerenciar documentos fiscais'),
  ('10000000-0000-4000-8000-000000000024', 'fiscal.own.read', 'Consultar documentos fiscais próprios liberados'),
  ('10000000-0000-4000-8000-000000000025', 'resources.read', 'Consultar serviços, salas e equipamentos'),
  ('10000000-0000-4000-8000-000000000026', 'resources.manage', 'Gerenciar serviços, salas e equipamentos'),
  ('10000000-0000-4000-8000-000000000027', 'audit.read', 'Consultar a trilha de auditoria')
ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description;

-- Esta tabela torna a matriz inicial inspecionável e permite que toda nova
-- organização receba os mesmos padrões sem duplicar regras no backend.
CREATE TABLE role_permission_defaults (
  role_code text NOT NULL,
  permission_id uuid NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_id)
);

INSERT INTO role_permission_defaults (role_code, permission_id)
SELECT matrix.role_code, permission.id
FROM (VALUES
  ('owner', 'organization.manage'), ('owner', 'schedule.manage'),
  ('owner', 'clients.read'), ('owner', 'finance.manage'),
  ('owner', 'clinical.write'), ('owner', 'organization.read'),
  ('owner', 'memberships.read'), ('owner', 'memberships.manage'),
  ('owner', 'roles.read'), ('owner', 'roles.manage_privileged'),
  ('owner', 'schedule.read'), ('owner', 'schedule.own.read'),
  ('owner', 'schedule.own.manage'), ('owner', 'clients.manage'),
  ('owner', 'clients.own.read'), ('owner', 'prospects.read'),
  ('owner', 'prospects.manage'), ('owner', 'clinical.read'),
  ('owner', 'clinical.published.read'), ('owner', 'finance.read'),
  ('owner', 'finance.own.read'), ('owner', 'fiscal.read'),
  ('owner', 'fiscal.manage'), ('owner', 'fiscal.own.read'),
  ('owner', 'resources.read'), ('owner', 'resources.manage'),
  ('owner', 'audit.read'),

  ('admin', 'organization.manage'), ('admin', 'organization.read'),
  ('admin', 'memberships.read'), ('admin', 'memberships.manage'),
  ('admin', 'roles.read'), ('admin', 'schedule.read'),
  ('admin', 'schedule.manage'), ('admin', 'clients.read'),
  ('admin', 'clients.manage'), ('admin', 'prospects.read'),
  ('admin', 'prospects.manage'), ('admin', 'finance.read'),
  ('admin', 'finance.manage'), ('admin', 'fiscal.read'),
  ('admin', 'fiscal.manage'), ('admin', 'resources.read'),
  ('admin', 'resources.manage'), ('admin', 'audit.read'),

  ('professional', 'schedule.read'), ('professional', 'schedule.manage'),
  ('professional', 'clients.read'), ('professional', 'clinical.read'),
  ('professional', 'clinical.write'), ('professional', 'resources.read'),

  ('reception_finance', 'schedule.read'), ('reception_finance', 'schedule.manage'),
  ('reception_finance', 'clients.read'), ('reception_finance', 'clients.manage'),
  ('reception_finance', 'prospects.read'), ('reception_finance', 'prospects.manage'),
  ('reception_finance', 'finance.read'), ('reception_finance', 'finance.manage'),
  ('reception_finance', 'fiscal.read'), ('reception_finance', 'fiscal.manage'),
  ('reception_finance', 'resources.read'),

  ('client', 'schedule.own.read'), ('client', 'schedule.own.manage'),
  ('client', 'clients.own.read'), ('client', 'clinical.published.read'),
  ('client', 'finance.own.read'), ('client', 'fiscal.own.read')
) AS matrix(role_code, permission_code)
JOIN permissions permission ON permission.code = matrix.permission_code;

INSERT INTO role_permissions (organization_id, role_id, permission_id)
SELECT role.organization_id, role.id, defaults.permission_id
FROM roles role
JOIN role_permission_defaults defaults ON defaults.role_code = role.code
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT ON TABLE permissions, role_permission_defaults TO clinicflow_app;
  END IF;
END;
$$;
