# REPOR-005 — Dashboard de negócio

## Resultado

O dashboard de negócio reúne indicadores financeiros e operacionais para o período selecionado. Unidade, profissional e situação do cliente seguem os filtros compartilhados de `REPOR-001`, e nenhum total é recalculado no navegador.

## Conciliação financeira

- **Faturado** soma os valores originais dos recebíveis não cancelados cuja competência está no período.
- **Recebido líquido** soma o livro imutável de pagamentos pela data do lançamento; estornos negativos reduzem o indicador.
- **Saldo em aberto** soma o saldo atual da visão conciliada `receivable_balances` para vencimentos do período, sem produzir valores negativos.

Os filtros de unidade e profissional atribuem o recebível pelo cliente, usando uma participação válida na mesma combinação de recursos. Clientes excluídos ou arquivados nunca entram na base.

## Indicadores operacionais

Agendamentos, realizados, presenças e faltas vêm de `appointments` e `appointment_participants`. A data é calculada no calendário local da unidade. A taxa de presença é `presenças / (presenças + faltas)`; quando não há desfechos, retorna zero.

## API, exportação e evidências

- `GET /api/organizations/:organizationId/reports/dashboard`
- `GET /api/organizations/:organizationId/reports/dashboard/export`

As rotas exigem `reports.read`, não permitem cache e a exportação CSV usa exatamente os indicadores retornados pelo repositório. Testes de serviço, HTTP, componente e PostgreSQL cobrem validação, filtros, conciliação e apresentação.
