# REPOR-001 — Infraestrutura de filtros e exportação

## Resultado

Relatórios profissionais usam um contrato único para período, unidade, profissional e situação. A API valida os filtros, aplica isolamento por organização e pagina a visualização. A exportação reutiliza a mesma consulta e os mesmos filtros, em vez de recalcular os dados no navegador.

## Contrato HTTP

| Método | Rota | Permissão | Resultado |
| --- | --- | --- | --- |
| `GET` | `/api/organizations/:organizationId/reports/filters` | `reports.read` | Unidades, profissionais e situações disponíveis. |
| `GET` | `/api/organizations/:organizationId/reports/birthdays` | `reports.read` | Relatório paginado com `appliedFilters`. |
| `GET` | `/api/organizations/:organizationId/reports/birthdays/export` | `reports.read` | A mesma seleção em CSV UTF-8. |

Os relatórios aceitam `from` e `to` obrigatórios em `YYYY-MM-DD`, `unitId`, `professionalId` e `status` opcionais, além de `page` e `pageSize` apenas na visualização. O período é inclusivo e limitado a 367 dias. Unidade e profissional, quando usados juntos, precisam corresponder ao mesmo agendamento associado ao cliente.

## Segurança e limites

- `reports.read` é concedida por padrão somente a proprietário, administrador e recepção/financeiro; cliente e profissional não recebem acesso amplo a relatórios.
- O servidor e o repositório verificam novamente permissão e organização.
- A resposta e o CSV usam `Cache-Control: no-store`.
- A exportação é limitada a 10.000 linhas e solicita refinamento acima disso.
- Campos CSV são delimitados e valores iniciados por caracteres de fórmula recebem escape contra CSV injection.

## Interface e evidências

A navegação profissional inclui “Relatórios”. A página tem filtros responsivos, estados de carregamento, vazio e erro, paginação e exportação. Testes de serviço, HTTP, componente e PostgreSQL cobrem validação, encaminhamento dos filtros, autorização, formato e rollback da migration reversível `029_reports_birthdays`.

