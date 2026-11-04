-- Apenas dados sintéticos. Domínios .invalid são reservados e não recebem e-mail.
INSERT INTO users (id, identity_provider_subject, email_normalized, status) VALUES
  ('00000000-0000-4000-8000-000000000001', 'synthetic-owner-a', 'proprietario.a@example.invalid', 'active'),
  ('00000000-0000-4000-8000-000000000002', 'synthetic-professional-a', 'profissional.a@example.invalid', 'active'),
  ('00000000-0000-4000-8000-000000000003', 'synthetic-owner-b', 'proprietario.b@example.invalid', 'active'),
  ('00000000-0000-4000-8000-000000000004', 'synthetic-client-a', 'cliente.a@example.invalid', 'active')
ON CONFLICT DO NOTHING;

-- Conta exclusivamente sintética para validar o fluxo local de login.
-- Senha: ClinicaDemo!2026 (nunca reutilizar fora do ambiente local).
INSERT INTO user_credentials (user_id, password_hash) VALUES
  ('00000000-0000-4000-8000-000000000001', 'scrypt$16384$8$1$E4YDOHZcLuWbbchCnsehUA$CPCMiQa4xX6JvVzQ7II_CAluqyPX-01PYmD-mIWq-jT3bnu8gcanpJZr8fNNgF6jBikvdWsHPwNSzXpm0Jq4vA'),
  ('00000000-0000-4000-8000-000000000004', 'scrypt$16384$8$1$E4YDOHZcLuWbbchCnsehUA$CPCMiQa4xX6JvVzQ7II_CAluqyPX-01PYmD-mIWq-jT3bnu8gcanpJZr8fNNgF6jBikvdWsHPwNSzXpm0Jq4vA')
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO permissions (id, code, description) VALUES
  ('10000000-0000-4000-8000-000000000001', 'organization.manage', 'Gerenciar a organização'),
  ('10000000-0000-4000-8000-000000000002', 'schedule.manage', 'Gerenciar a agenda'),
  ('10000000-0000-4000-8000-000000000003', 'clients.read', 'Consultar clientes permitidos'),
  ('10000000-0000-4000-8000-000000000004', 'finance.manage', 'Gerenciar financeiro'),
  ('10000000-0000-4000-8000-000000000005', 'clinical.write', 'Registrar conteúdo clínico')
ON CONFLICT DO NOTHING;

SELECT set_config('app.organization_id', 'aaaaaaaa-0000-4000-8000-000000000001', true);

INSERT INTO organizations (id, legal_name, trade_name, status)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'Organização Sintética Alfa', 'Clínica Demo Alfa', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO organization_contact_channels
  (id, organization_id, channel, label, value, position) VALUES
  ('aaaaaaaa-1200-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'whatsapp', 'WhatsApp da clínica', '+5547999990000', 1),
  ('aaaaaaaa-1200-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'email', 'E-mail da clínica', 'contato@clinica-demo.invalid', 2)
ON CONFLICT DO NOTHING;

INSERT INTO units (id, organization_id, name, timezone, address) VALUES
  ('aaaaaaaa-1000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Unidade Sintética Centro', 'America/Sao_Paulo', '{"city":"Cidade Exemplo","state":"SC"}')
ON CONFLICT DO NOTHING;

INSERT INTO roles (id, organization_id, code, name, privileged) VALUES
  ('aaaaaaaa-2000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'owner', 'Proprietário', true),
  ('aaaaaaaa-2000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'admin', 'Administrador', true),
  ('aaaaaaaa-2000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'professional', 'Profissional', false),
  ('aaaaaaaa-2000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'reception_finance', 'Recepção/Financeiro', false),
  ('aaaaaaaa-2000-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'client', 'Cliente', false)
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (organization_id, role_id, permission_id)
SELECT 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2000-4000-8000-000000000001', id FROM permissions
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (organization_id, role_id, permission_id) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000003'),
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-2000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000005')
ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (organization_id, role_id, permission_id)
SELECT 'aaaaaaaa-0000-4000-8000-000000000001',
       'aaaaaaaa-2000-4000-8000-000000000003', id
FROM permissions WHERE code = 'resources.read'
ON CONFLICT DO NOTHING;
-- Mantém as funções sintéticas alinhadas à matriz vigente, inclusive as
-- permissões adicionadas depois da primeira versão do seed.
INSERT INTO role_permissions (organization_id, role_id, permission_id)
SELECT role.organization_id, role.id, defaults.permission_id
FROM roles role
JOIN role_permission_defaults defaults ON defaults.role_code = role.code
WHERE role.organization_id = 'aaaaaaaa-0000-4000-8000-000000000001'
ON CONFLICT DO NOTHING;

INSERT INTO memberships (id, organization_id, user_id, role_id, status) VALUES
  ('aaaaaaaa-3000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'aaaaaaaa-2000-4000-8000-000000000001', 'active'),
  ('aaaaaaaa-3000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', 'aaaaaaaa-2000-4000-8000-000000000003', 'active'),
  ('aaaaaaaa-3000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'aaaaaaaa-2000-4000-8000-000000000005', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO professionals (id, organization_id, membership_id, display_name, registration_number, specialties) VALUES
  ('aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-3000-4000-8000-000000000002', 'Profissional Sintético 001', 'CREFITO-3/12345-F', ARRAY['Pilates demonstrativo'])
ON CONFLICT DO NOTHING;

INSERT INTO clients (id, organization_id, user_id, full_name, birth_date, client_type) VALUES
  ('aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000004', 'Cliente Sintético 001', DATE '1990-01-01', 'fixed'),
  ('aaaaaaaa-5000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', NULL, 'Cliente Sintético 002', DATE '1992-02-02', 'rotating')
ON CONFLICT DO NOTHING;

INSERT INTO assessments
  (id, organization_id, client_id, professional_id, assessment_type, structured_data,
   publication_status, assessed_at) VALUES
  ('aaaaaaaa-5100-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'Avaliação funcional', '{"Resumo":"Evolução sintética dentro do esperado","Mobilidade":"Boa"}', 'published', '2026-08-20 09:00:00-03'),
  ('aaaaaaaa-5100-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'Rascunho privado', '{"observacao":"Não deve aparecer"}', 'private', '2026-09-01 09:00:00-03'),
  ('aaaaaaaa-5100-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000002', 'aaaaaaaa-4000-4000-8000-000000000001', 'Avaliação de outro cliente', '{"observacao":"Conteúdo de outro cliente"}', 'published', '2026-08-25 09:00:00-03')
ON CONFLICT DO NOTHING;

INSERT INTO workout_plans
  (id, organization_id, client_id, professional_id, title, instructions,
   publication_status, valid_until) VALUES
  ('aaaaaaaa-5200-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'Treino sintético de mobilidade', '{"Frequência":"3 vezes por semana","Orientação":"Realize somente como orientado pelo profissional"}', 'published', DATE '2026-12-31'),
  ('aaaaaaaa-5200-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'Treino retirado', '{}', 'withdrawn', NULL)
ON CONFLICT DO NOTHING;

INSERT INTO clinical_records
  (id, organization_id, client_id, author_professional_id, record_type, content,
   occurred_at, signed_at, professional_registration) VALUES
  ('aaaaaaaa-5300-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'evolucao', 'Paciente realizou sessão de Pilates clínico e fisioterapia motora. Sem dor lombar, bom controle de core.', '2026-09-02 14:00:00-03', '2026-09-02 14:05:00-03', 'CREFITO-3/12345-F')
ON CONFLICT DO NOTHING;

INSERT INTO client_contacts (id, organization_id, client_id, type, value, preferred) VALUES
  ('aaaaaaaa-5100-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'email', 'cliente.001@example.invalid', true)
ON CONFLICT DO NOTHING;

INSERT INTO client_consents
  (id, organization_id, client_id, purpose, legal_basis, granted_at, evidence_ref) VALUES
  ('aaaaaaaa-5110-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'birthday_contact', 'consent', now(), 'synthetic-seed')
ON CONFLICT DO NOTHING;

INSERT INTO prospects
  (id, organization_id, owner_professional_id, full_name, stage, source, next_action_at, next_action_note)
VALUES
  ('aaaaaaaa-5200-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'Prospecção Sintética Marina', 'contacted', 'Indicação sintética', '2026-09-03 10:00:00-03', 'Confirmar aula experimental'),
  ('aaaaaaaa-5200-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', NULL, 'Prospecção Sintética Roberto', 'qualified', 'Instagram sintético', '2026-09-04 15:30:00-03', 'Enviar proposta de plano'),
  ('aaaaaaaa-5200-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'Prospecção Sintética Elisa', 'new', 'Site sintético', NULL, NULL)
ON CONFLICT DO NOTHING;

INSERT INTO prospect_contacts
  (id, organization_id, prospect_id, type, value, preferred)
VALUES
  ('aaaaaaaa-5210-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5200-4000-8000-000000000001', 'phone', '(47) 99999-5201', true),
  ('aaaaaaaa-5210-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5200-4000-8000-000000000002', 'email', 'prospeccao.002@example.invalid', true),
  ('aaaaaaaa-5210-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5200-4000-8000-000000000003', 'phone', '(47) 99999-5203', true)
ON CONFLICT DO NOTHING;

INSERT INTO prospect_interactions
  (id, organization_id, prospect_id, type, notes, occurred_at)
VALUES
  ('aaaaaaaa-5220-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5200-4000-8000-000000000001', 'call', 'Contato sintético: demonstrou interesse em aula experimental.', '2026-09-01 11:00:00-03')
ON CONFLICT DO NOTHING;

INSERT INTO modalities (id, organization_id, name) VALUES
  ('aaaaaaaa-6000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Modalidade Sintética')
ON CONFLICT DO NOTHING;
INSERT INTO services (id, organization_id, modality_id, name, duration_minutes, default_capacity) VALUES
  ('aaaaaaaa-6100-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6000-4000-8000-000000000001', 'Aula Demonstrativa', 50, 4)
ON CONFLICT DO NOTHING;
INSERT INTO rooms (id, organization_id, unit_id, name, capacity) VALUES
  ('aaaaaaaa-6200-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'Sala Sintética 01', 4)
ON CONFLICT DO NOTHING;
INSERT INTO equipment (id, organization_id, unit_id, name, quantity) VALUES
  ('aaaaaaaa-6250-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'Reformer Sintético', 4)
ON CONFLICT DO NOTHING;
INSERT INTO availability_rules
  (id, organization_id, professional_id, unit_id, rule_type, kind, weekday,
   local_start_time, local_end_time, timezone, label)
VALUES
  ('aaaaaaaa-6260-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'available', 'working_hours', 1, '07:00', '19:00', 'America/Sao_Paulo', 'Expediente de segunda'),
  ('aaaaaaaa-6260-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'available', 'working_hours', 2, '07:00', '19:00', 'America/Sao_Paulo', 'Expediente de terça'),
  ('aaaaaaaa-6260-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'available', 'working_hours', 3, '07:00', '19:00', 'America/Sao_Paulo', 'Expediente de quarta'),
  ('aaaaaaaa-6260-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'available', 'working_hours', 4, '07:00', '19:00', 'America/Sao_Paulo', 'Expediente de quinta'),
  ('aaaaaaaa-6260-4000-8000-000000000005', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'available', 'working_hours', 5, '07:00', '19:00', 'America/Sao_Paulo', 'Expediente de sexta'),
  ('aaaaaaaa-6260-4000-8000-000000000006', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'blocked', 'break', 2, '12:00', '13:00', 'America/Sao_Paulo', 'Intervalo de almoço')
ON CONFLICT DO NOTHING;
INSERT INTO appointments (id, organization_id, unit_id, service_id, professional_id, room_id, starts_at, ends_at, capacity, appointment_type) VALUES
  ('aaaaaaaa-6300-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-1000-4000-8000-000000000001', 'aaaaaaaa-6100-4000-8000-000000000001', 'aaaaaaaa-4000-4000-8000-000000000001', 'aaaaaaaa-6200-4000-8000-000000000001', '2026-09-01 13:00:00-03', '2026-09-01 13:50:00-03', 4, 'class')
ON CONFLICT DO NOTHING;
INSERT INTO appointment_participants (id, organization_id, appointment_id, client_id, status) VALUES
  ('aaaaaaaa-6400-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6300-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'confirmed')
ON CONFLICT DO NOTHING;
INSERT INTO appointment_equipment (organization_id, appointment_id, equipment_id, quantity) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-6300-4000-8000-000000000001', 'aaaaaaaa-6250-4000-8000-000000000001', 2)
ON CONFLICT DO NOTHING;

INSERT INTO plans (id, organization_id, name, price_cents, billing_rule) VALUES
  ('aaaaaaaa-7000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'Plano Sintético Mensal', 25000, '{"frequency":"monthly"}')
ON CONFLICT DO NOTHING;
INSERT INTO financial_categories (id, organization_id, kind, name) VALUES
  ('aaaaaaaa-7100-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'receivable', 'Mensalidade sintética'),
  ('aaaaaaaa-7100-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'payable', 'Operação sintética')
ON CONFLICT DO NOTHING;
INSERT INTO payables
  (id, organization_id, category_id, counterparty, description, amount_cents,
   competence_on, due_on, idempotency_key) VALUES
  ('aaaaaaaa-7500-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001',
   'aaaaaaaa-7100-4000-8000-000000000002', 'Fornecedor Sintético Ltda.',
   'Aluguel sintético de setembro', 180000, DATE '2026-09-01', DATE '2026-09-08',
   'seed:payable:alpha:001')
ON CONFLICT DO NOTHING;
INSERT INTO contracts (id, organization_id, client_id, plan_id, starts_on, agreed_price_cents, status) VALUES
  ('aaaaaaaa-7200-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-7000-4000-8000-000000000001', DATE '2026-09-01', 25000, 'active')
ON CONFLICT DO NOTHING;
INSERT INTO receivables
  (id, organization_id, client_id, contract_id, category_id, description,
   original_amount_cents, competence_on, due_on, idempotency_key) VALUES
  ('aaaaaaaa-7300-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-5000-4000-8000-000000000001', 'aaaaaaaa-7200-4000-8000-000000000001', 'aaaaaaaa-7100-4000-8000-000000000001', 'Mensalidade sintética de setembro', 25000, DATE '2026-09-01', DATE '2026-09-10', 'seed:receivable:alpha:001')
ON CONFLICT DO NOTHING;

INSERT INTO outbox_events (id, organization_id, aggregate_type, aggregate_id, event_type, safe_payload, idempotency_key) VALUES
  ('aaaaaaaa-8000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'appointment', 'aaaaaaaa-6300-4000-8000-000000000001', 'appointment.created', '{}', 'seed:outbox:alpha:001')
ON CONFLICT DO NOTHING;
INSERT INTO audit_events (id, organization_id, actor_membership_id, action, target_type, target_id, minimal_metadata) VALUES
  ('aaaaaaaa-8100-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-3000-4000-8000-000000000001', 'seed.created', 'organization', 'aaaaaaaa-0000-4000-8000-000000000001', '{"source":"synthetic-seed"}')
ON CONFLICT DO NOTHING;

SELECT set_config('app.organization_id', 'bbbbbbbb-0000-4000-8000-000000000001', true);

INSERT INTO organizations (id, legal_name, trade_name, status)
VALUES ('bbbbbbbb-0000-4000-8000-000000000001', 'Organização Sintética Beta', 'Clínica Demo Beta', 'active')
ON CONFLICT DO NOTHING;
INSERT INTO units (id, organization_id, name) VALUES
  ('bbbbbbbb-1000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'Unidade Sintética Beta')
ON CONFLICT DO NOTHING;
INSERT INTO roles (id, organization_id, code, name, privileged) VALUES
  ('bbbbbbbb-2000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'owner', 'Proprietário', true)
ON CONFLICT DO NOTHING;
INSERT INTO memberships (id, organization_id, user_id, role_id, status) VALUES
  ('bbbbbbbb-3000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003', 'bbbbbbbb-2000-4000-8000-000000000001', 'active')
ON CONFLICT DO NOTHING;
INSERT INTO clients (id, organization_id, full_name, client_type) VALUES
  ('bbbbbbbb-5000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-000000000001', 'Cliente Sintético Beta 001', 'rotating')
ON CONFLICT DO NOTHING;

SELECT set_config('app.organization_id', '', true);
