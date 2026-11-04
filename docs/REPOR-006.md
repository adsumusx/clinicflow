# REPOR-006 — Aparelhos utilizados

## Regra de uso realizado

Um aparelho só é contado quando está associado a um agendamento com estado `completed` e esse agendamento possui ao menos uma participação `attended`. Reservas, confirmações, faltas, cancelamentos e agendamentos ainda abertos não transformam uma alocação em uso realizado.

A data pertence ao calendário local da unidade. Os filtros compartilhados de período, unidade, profissional e situação do cliente são aplicados no servidor; o filtro adicional de modalidade deriva do serviço do próprio agendamento.

## Totais e detalhes

O resumo informa tipos de aparelhos utilizados, agendamentos realizados distintos e quantidade total alocada. O detalhe agrupa aparelho e modalidade, apresentando unidade, estoque disponível, agendamentos, quantidade alocada, presenças e último uso. Paginação, totais e CSV usam a mesma base SQL.

## API, exportação e evidências

- `GET /api/organizations/:organizationId/reports/equipment-usage`
- `GET /api/organizations/:organizationId/reports/equipment-usage/export`

As rotas exigem `reports.read`, respondem com `Cache-Control: no-store` e limitam a exportação a 10.000 combinações de aparelho e modalidade. Testes de serviço, HTTP, componente e PostgreSQL comprovam o filtro por modalidade e impedem que uma mera reserva seja contabilizada como utilização.
