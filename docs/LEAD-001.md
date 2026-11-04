# LEAD-001 — Funil de prospecções

## Resultado

O módulo **Prospecções** está disponível na navegação profissional. Cada oportunidade registra etapa, origem, responsável, contatos estruturados e próxima ação, com busca, filtro por etapa, paginação e histórico de interações.

## Etapas e dados

O funil usa as etapas `new`, `contacted`, `qualified`, `proposal`, `lost` e `converted`. A etapa `converted` é exclusiva da conversão transacional de `LEAD-002`; uma atualização comum não pode produzi-la nem alterar uma prospecção já convertida.

- Nome e origem são obrigatórios e normalizados.
- O responsável, quando informado, precisa ser um profissional ativo da organização.
- E-mail, telefone e outros contatos são normalizados e não podem se repetir na mesma prospecção.
- Descrição e instante da próxima ação são informados em conjunto; ações atrasadas permanecem visíveis para acompanhamento.
- Ligações, e-mails, mensagens, reuniões e anotações entram em `prospect_interactions`. Mudanças de etapa também geram uma interação técnica.

## Contrato HTTP

| Método | Rota | Permissão | Resultado |
| --- | --- | --- | --- |
| `GET` | `/api/organizations/:organizationId/prospects` | `prospects.read` | Lista paginada, responsáveis disponíveis e contagens do funil. |
| `GET` | `/api/organizations/:organizationId/prospects/:prospectId` | `prospects.read` | Cadastro com até 50 interações recentes. |
| `POST` | `/api/organizations/:organizationId/prospects` | `prospects.manage` | Cria a prospecção e os contatos na mesma transação. |
| `PUT` | `/api/organizations/:organizationId/prospects/:prospectId` | `prospects.manage` | Atualiza dados, contatos, etapa e próxima ação. |
| `POST` | `/api/organizations/:organizationId/prospects/:prospectId/interactions` | `prospects.manage` | Acrescenta uma interação ao histórico. |

A listagem aceita `stage`, `q`, `page` e `pageSize`; a busca por nome ou contato ocorre no PostgreSQL. Entradas inválidas retornam códigos `INVALID_PROSPECT*` sem expor SQL ou dados pessoais.

## Segurança, auditoria e interface

A sessão e o repositório verificam novamente as capacidades granulares. Todas as consultas usam o contexto de usuário e organização e as tabelas `prospects`, `prospect_contacts` e `prospect_interactions` ficam protegidas por RLS. Mutações HTTP também exigem contexto de mesma origem.

Eventos `prospect.created`, `prospect.updated` e `prospect.interaction.created` guardam somente etapa, tipos de contato e indicadores operacionais; nome, origem em texto livre, valores de contato e notas não entram na auditoria ou nos logs.

A interface possui estados de carregamento, vazio, erro e sucesso, controles rotulados, filtros com `aria-pressed` e layout responsivo. O seed local inclui somente oportunidades sintéticas.

## Evidências

Testes cobrem normalização e validação, RBAC, RLS, isolamento entre clínicas, busca e filtros, responsável, contatos, próxima ação, interações, auditoria sem dados pessoais, rotas HTTP e o fluxo pela interface. Execute `npm run check` para a verificação completa.
