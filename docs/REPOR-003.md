# REPOR-003 — Clientes: geral e planos fixos

## Resultado

O relatório de clientes possui as visões `Geral` e `Planos fixos`. A base inclui clientes não excluídos e não arquivados cuja data de cadastro esteja no período inclusivo. A visão fixa aplica `client_type = 'fixed'` sobre essa mesma base.

Os cartões de total, fixos, rotativos, ativos e inativos são agregados pela mesma cláusula SQL que produz os detalhes paginados. Assim, filtros de período, situação, unidade, profissional e tipo nunca são recalculados no navegador.

## Plano exibido

Para cada cliente, o relatório mostra o contrato ativo mais recente que se sobreponha ao período selecionado. O contrato precisa começar até o fim do intervalo e não pode terminar antes do início. Um cliente fixo continua no total mesmo quando não há contrato ativo no intervalo; nesse caso, a ausência aparece explicitamente no detalhe.

## API e exportação

- `GET /api/organizations/:organizationId/reports/clients`
- `GET /api/organizations/:organizationId/reports/clients/export`

Além dos filtros compartilhados de `REPOR-001`, as rotas aceitam `clientType=all|fixed`. A exportação CSV usa a mesma consulta, possui proteção contra fórmulas e mantém o limite de 10.000 detalhes.

## Segurança e evidências

As rotas exigem `reports.read`, repetem autorização e isolamento no repositório e respondem com `Cache-Control: no-store`. Testes de serviço, HTTP, interface e PostgreSQL verificam normalização, conciliação entre total e detalhes e plano correspondente ao período.
