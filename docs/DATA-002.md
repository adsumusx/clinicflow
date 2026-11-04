# DATA-002 — PostgreSQL, migrations e dados sintéticos

> Estado: **Concluída**. Revisão: 2026-09-01.

## Resultado

O modelo conceitual de [`DATA-001`](./DATA-001.md) possui agora um esquema físico PostgreSQL recriável, migrations ordenadas e reversíveis, RLS multiempresa, constraints de consistência e um seed idempotente composto apenas por dados sintéticos.

## Estrutura

```text
database/
├── init/                         # papel local sem BYPASSRLS
├── migrations/
│   ├── 001_identity.*.sql       # organização, identidade, RBAC e sessões
│   ├── 002_crm_schedule.*.sql   # CRM, clínico, agenda, fila e reposição
│   ├── 003_finance_platform.*.sql # financeiro, fiscal e plataforma
│   └── 004_integrity_rls.*.sql  # triggers, integridade e políticas RLS
├── seeds/development.sql        # duas clínicas e dados explicitamente sintéticos
└── schema.test.mjs              # testes executados em PostgreSQL/WASM

scripts/db/
├── migrate.mjs                  # histórico, lock e transação por migration
├── seed.mjs                     # seed transacional
└── reset.mjs                    # rollback total, migrate e seed com trava local
```

Cada arquivo `up` possui um `down` correspondente. `schema_migrations` registra versões aplicadas e um advisory lock impede dois processos de migration simultâneos.

## Uso local

Requisitos para o banco persistente: Docker com Compose. As credenciais incluídas são deliberadamente locais e não podem ser reutilizadas fora do desenvolvimento.
O contêiner publica PostgreSQL em `localhost:5433` para não colidir com instalações locais que normalmente usam `5432`.

```powershell
Copy-Item .env.example .env
npm run db:up
npm run db:reset
```

Comandos disponíveis:

| Comando | Resultado |
| --- | --- |
| `npm run db:up` | Inicia PostgreSQL 17 local. |
| `npm run db:migrate` | Aplica somente migrations pendentes. |
| `npm run db:rollback` | Reverte a última migration. |
| `npm run db:seed` | Reaplica o seed idempotente. |
| `npm run db:reset` | Reverte tudo, reaplica e semeia; recusa produção, host remoto e nomes fora da lista local permitida. |
| `npm run db:down` | Encerra o contêiner sem apagar o volume. |

`DATABASE_URL` é administrativa e deve ser usada somente por migrations e tarefas operacionais. O backend deverá usar `APP_DATABASE_URL`, cujo papel local `clinicflow_app` é `NOSUPERUSER` e `NOBYPASSRLS`.
Esse papel não possui acesso à tabela `schema_migrations`.

## Proteções implementadas

- `organization_id NOT NULL` e FKs compostas impedem vínculos entre tenants.
- RLS é habilitada e forçada em todas as tabelas de negócio; sem `app.organization_id`, a política nega por padrão.
- Papéis globais de plataforma não recebem acesso implícito a uma clínica.
- Triggers serializam a ocupação e impedem overbooking, conflito de profissional/sala e excesso de equipamento.
- Fila permite somente uma oferta ativa por agendamento; créditos de reposição possuem origem e consumo únicos.
- Registros de auditoria, eventos fiscais e pagamentos são append-only; prontuário assinado exige adendo.
- Recebíveis, pagamentos e estornos preservam valor original e expõem saldo por view com `security_invoker`.
- Chaves de idempotência são únicas por organização em recebíveis, pagamentos, documentos fiscais e Outbox.
- Vínculos de arquivo validam tenant, tipo e existência do alvo.

As regras desta fundação foram ampliadas em [`AUTH-003`](./AUTH-003.md) e [`AUTH-004`](./AUTH-004.md): o RBAC agora nega por padrão e a RLS também exige usuário ativo com membership ativa no tenant.

## Seed seguro

O seed usa UUIDs fixos para ser repetível, domínios `example.invalid`, nomes contendo “Sintético” e nenhum documento, contato ou dado clínico real. Ele cria duas organizações para permitir testes negativos de isolamento.

Dados reais continuam proibidos em desenvolvimento e homologação. Antes da produção, credenciais, papéis, retenção, backup e restauração dependem dos portões do marco M9.

## Verificação automatizada

`database/schema.test.mjs` inicia um PostgreSQL real compilado para WebAssembly, aplica todos os arquivos `up` em um banco vazio e verifica:

1. criação de pelo menos 45 tabelas e carga idempotente do seed;
2. ausência de identidades que não estejam marcadas como sintéticas;
3. rejeição de FK cruzada entre clínicas;
4. RLS com troca explícita de tenant e negação sem contexto;
5. rejeição de overbooking e redução inválida de capacidade;
6. reconciliação de pagamento parcial e estorno, preservando lançamentos;
7. execução de todos os arquivos `down` até retornar a um banco vazio.

O PostgreSQL em contêiner continua sendo o ambiente persistente e de validação operacional. PostgreSQL/WASM existe somente para testes rápidos e determinísticos, sem substituir os testes de concorrência de `QA-002`.

## Validação no PostgreSQL nativo

Em 2026-09-01, o fluxo foi executado também no contêiner `postgres:17-alpine` após habilitar WSL 2 no Windows:

- contêiner saudável em `localhost:5433`;
- quatro migrations registradas e 48 tabelas físicas;
- rollback e reaplicação de `004_integrity_rls` concluídos;
- seed reaplicado sem duplicação: duas organizações e três clientes sintéticos;
- papel `clinicflow_app` visualizou zero organizações sem tenant;
- no contexto Alfa, visualizou somente a Clínica Demo Alfa e zero registros da organização Beta;
- tentativa de leitura de `schema_migrations` pelo papel da aplicação foi negada.
