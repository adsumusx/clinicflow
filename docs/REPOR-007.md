# REPOR-007 — Prospecções

## Coorte e indicadores

O relatório considera as prospecções cadastradas no período inclusivo selecionado. Sobre essa mesma coorte, calcula total, oportunidades em andamento, conversões, perdas, taxas de conversão e perda e tempo médio de ciclo.

O ciclo termina na conversão (`converted_at`) ou na entrada mais recente na etapa `lost`. Para perdas antigas sem uma interação técnica de mudança de etapa, `updated_at` é a referência compatível. O tempo médio usa somente oportunidades com desfecho e nunca retorna duração negativa.

## Origem, etapa e filtros

As etapas atuais são conciliadas nas seis posições do funil: nova, contatada, qualificada, proposta, perdida e convertida. O desempenho por origem apresenta total, conversões, perdas e taxa de conversão; resumo, agrupamentos e detalhes usam exatamente a mesma base.

O filtro de profissional corresponde ao responsável pela prospecção. Como a prospecção não possui unidade nem situação de cliente, esses filtros selecionam somente conversões cujo cliente resultante possui a situação pedida e vínculo operacional válido com a unidade. Essa regra evita atribuir unidade ou situação fictícia a oportunidades ainda abertas.

## API, exportação e evidências

- `GET /api/organizations/:organizationId/reports/prospects`
- `GET /api/organizations/:organizationId/reports/prospects/export`

As rotas exigem `reports.read`, não permitem cache, paginam os detalhes e limitam a exportação a 10.000 prospecções. O CSV reutiliza a consulta do relatório e neutraliza valores que poderiam ser interpretados como fórmulas.

Testes de serviço, HTTP, componente e PostgreSQL cobrem filtros, totais, agrupamentos, taxas, ciclo de conversão e perda, apresentação e exportação segura.
