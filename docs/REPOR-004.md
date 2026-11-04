# REPOR-004 — Atividade de clientes por mês e ano

## Regra de atividade

Um cliente é ativo no período quando possui ao menos uma participação com estado final `attended`. Reservas (`booked`), confirmações sem presença (`confirmed`), faltas (`absent`) e cancelamentos não contam como atividade. Agendamentos cancelados e clientes excluídos ou arquivados também não entram.

A data pertence ao calendário local da unidade do agendamento (`starts_at AT TIME ZONE unit.timezone`). Isso impede que uma sessão próxima da meia-noite caia no mês ou ano errado.

## Resumo e drill-down

O resumo agrupa por mês ou ano e inclui períodos sem atividade. Cada linha apresenta:

- clientes ativos distintos;
- quantidade total de presenças;
- início e fim efetivos dentro do filtro.

“Ver clientes” envia o identificador do próprio bucket (`YYYY-MM` ou `YYYY`) para a API. O detalhe agrupa a mesma base por cliente, informa presenças e última presença, e é paginado. Unidade, profissional e situação do cliente são aplicados antes tanto do resumo quanto do detalhe.

## API e exportação

- `GET /api/organizations/:organizationId/reports/client-activity`
- `GET /api/organizations/:organizationId/reports/client-activity/export`

As rotas aceitam os filtros compartilhados, `granularity=month|year` e `bucket` opcional. Sem `bucket`, o CSV exporta o resumo; com `bucket`, exporta o drill-down. O servidor valida que o bucket tenha o formato correto e intercepte o período filtrado.

## Segurança e evidências

O acesso exige `reports.read`, usa isolamento por organização, não permite cache e limita o drill-down exportado a 10.000 clientes. Testes de serviço, HTTP, interface e PostgreSQL cobrem agrupamento, validação do bucket e correspondência entre resumo e detalhes.
