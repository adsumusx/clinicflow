# ClinicFlow

Aplicação web para gestão integrada de clínicas de Pilates, fisioterapia e atendimentos médicos.

## Requisitos

- Node.js 22.12 ou superior
- npm 11 ou superior

## Desenvolvimento

```bash
npm install
npm run dev
```

Em outro terminal, inicie a API (o Vite encaminha `/api` para a porta 3001):

```bash
npm run dev:api
```

O Vite exibirá o endereço local da aplicação. Para servir o build e a API no mesmo processo, use `npm run build` e `npm start`.

O código-fonte segue a direção modular `app → pages → features → shared`. Imports entre módulos usam o alias `@`; consulte as [convenções do repositório](./docs/CONVENCOES_REPOSITORIO.md).

## Verificações

```bash
npm run typecheck
npm test
npm run build
```

Também é possível validar as fronteiras de importação isoladamente com `npm run check:imports` ou executar todas as verificações rápidas em sequência com `npm run check`. Mudanças nas regras de agenda devem executar também `npm run test:qa:schedule`, com o PostgreSQL local ativo; mudanças financeiras devem executar `npm run test:qa:finance`.

## Referências

- Planejamento e decisões: [`docs`](./docs)
- Telas e código exportados do Stitch: [`stitch_gest_o_cl_nica_integrada`](./stitch_gest_o_cl_nica_integrada)

Os arquivos do Stitch são referências de produto e design; a aplicação compilável vive em `src`. O [modelo de ameaças inicial](./docs/SEC-001.md) registra os riscos e os portões de segurança das próximas entregas.

## Banco de dados local

Com Docker disponível, o PostgreSQL pode ser recriado com migrations e seed sintético:

```bash
cp .env.example .env
npm run db:up
npm run db:reset
```

No PowerShell, use `Copy-Item .env.example .env` no primeiro comando. Consulte [`DATA-002`](./docs/DATA-002.md) para operação, rollback, RLS e regras do seed.

A área do cliente, incluindo check-in, fila de interesse, conteúdo publicado e contato com a clínica, pode ser validada localmente com `cliente.a@example.invalid` e a senha sintética `ClinicaDemo!2026`.

Push usa FCM HTTP v1 e tokens cifrados. Copie e troque `PUSH_TOKEN_ENCRYPTION_KEY`; para ativar o worker, configure também `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY`. Sem essas credenciais o worker permanece inativo, sem descartar eventos da Outbox.

O seed inclui a conta local sintética `proprietario.a@example.invalid`, com senha `ClinicaDemo!2026`; no primeiro acesso privilegiado será solicitado o cadastro TOTP. Consulte [`AUTH-001`](./docs/AUTH-001.md), [`AUTH-002`](./docs/AUTH-002.md), [`AUTH-003`](./docs/AUTH-003.md), [`AUTH-004`](./docs/AUTH-004.md), [`AUTH-005`](./docs/AUTH-005.md), [`AUD-001`](./docs/AUD-001.md) e [`SEC-001`](./docs/SEC-001.md) para sessão, memberships, RBAC, isolamento, MFA, auditoria e ameaças. O módulo de clientes está documentado em [`CRM-001`](./docs/CRM-001.md), [`CRM-002`](./docs/CRM-002.md), [`CRM-003`](./docs/CRM-003.md), [`CRM-004`](./docs/CRM-004.md) e [`CRM-005`](./docs/CRM-005.md); o funil e sua conversão idempotente ficam em [`LEAD-001`](./docs/LEAD-001.md) e [`LEAD-002`](./docs/LEAD-002.md); os catálogos associados à agenda ficam em [`RES-001`](./docs/RES-001.md), e a agenda operacional em [`SCH-001`](./docs/SCH-001.md), [`SCH-002`](./docs/SCH-002.md), [`SCH-003`](./docs/SCH-003.md), [`SCH-004`](./docs/SCH-004.md), [`SCH-005`](./docs/SCH-005.md) e [`SCH-006`](./docs/SCH-006.md). A fila e as ofertas temporárias estão em [`WAIT-001`](./docs/WAIT-001.md) e [`WAIT-002`](./docs/WAIT-002.md); push e entrega por Outbox em [`PUSH-001`](./docs/PUSH-001.md) e [`PUSH-002`](./docs/PUSH-002.md). O financeiro está documentado em [`FIN-001`](./docs/FIN-001.md), [`FIN-002`](./docs/FIN-002.md), [`FIN-003`](./docs/FIN-003.md) e [`FIN-004`](./docs/FIN-004.md). A infraestrutura e os relatórios entregues estão em [`REPOR-001`](./docs/REPOR-001.md), [`REPOR-002`](./docs/REPOR-002.md), [`REPOR-003`](./docs/REPOR-003.md), [`REPOR-004`](./docs/REPOR-004.md), [`REPOR-005`](./docs/REPOR-005.md), [`REPOR-006`](./docs/REPOR-006.md) e [`REPOR-007`](./docs/REPOR-007.md). As provas concorrentes e de fuso estão registradas em [`QA-002`](./docs/QA-002.md), e a reconciliação financeira em [`QA-003`](./docs/QA-003.md).
