# Documentação do ClinicFlow

> Nome provisório do produto. Última revisão: 2026-09-03.

Esta pasta é a fonte de verdade para o planejamento do sistema de gestão de clínicas de Pilates, fisioterapia e atendimentos médicos.

## Documentos

- [Decisões do produto e da arquitetura](./DECISOES.md)
- [Arquitetura, dados e segurança](./ARQUITETURA_SEGURANCA.md)
- [Diagrama de dados inicial](./DATA-001.md)
- [PostgreSQL, migrations e dados sintéticos](./DATA-002.md)
- [Autenticação e sessões](./AUTH-001.md)
- [Organizações e memberships](./AUTH-002.md)
- [RBAC granular](./AUTH-003.md)
- [RLS e isolamento entre clínicas](./AUTH-004.md)
- [MFA para contas privilegiadas](./AUTH-005.md)
- [Convites por companhia, QR Code e cadastro exclusivo](./AUTH-006.md)
- [Trilha de auditoria](./AUD-001.md)
- [Modelo de ameaças inicial](./SEC-001.md)
- [CRUD seguro de clientes](./CRM-001.md)
- [Tipo fixo/rotativo de clientes](./CRM-002.md)
- [Busca, filtros e paginação de clientes](./CRM-003.md)
- [Perfil e histórico do cliente](./CRM-004.md)
- [Funil de prospecções](./LEAD-001.md)
- [Conversão de prospecção em cliente](./LEAD-002.md)
- [Serviços, modalidades, salas e aparelhos](./RES-001.md)
- [Disponibilidade e bloqueios](./SCH-001.md)
- [Agendamento individual](./SCH-002.md)
- [Turmas e capacidade compartilhada](./SCH-003.md)
- [Recorrências e cliente fixo](./SCH-004.md)
- [Salas e aparelhos na agenda](./SCH-005.md)
- [Presença, falta e cancelamento](./SCH-006.md)
- [Roadmap e backlog de implementação](./BACKLOG.md)
- [QA da primeira versão navegável](./QA-001.md)
- [QA de concorrência e fusos da agenda](./QA-002.md)
- [QA de reconciliação financeira](./QA-003.md)
- [Shell e início da área do cliente](./CLI-001.md)
- [Meus agendamentos e check-in](./CLI-002.md)
- [Treinos e avaliações liberadas](./CLI-003.md)
- [Contato](./CLI-004.md)
- [Fila de interesse](./WAIT-001.md)
- [Oferta temporária de vaga](./WAIT-002.md)
- [Confirmação da vaga oferecida](./WAIT-003.md)
- [Créditos de reposição](./REP-001.md)
- [Agendamento usando reposição](./REP-002.md)
- [FCM e preferências de push](./PUSH-001.md)
- [Entrega de push por Outbox](./PUSH-002.md)
- [Regras e modelo financeiro](./FIN-001.md)
- [Contas a receber](./FIN-002.md)
- [Recebimentos e estornos](./FIN-003.md)
- [Contas a pagar](./FIN-004.md)
- [Infraestrutura de filtros e exportação](./REPOR-001.md)
- [Relatório de aniversariantes](./REPOR-002.md)
- [Clientes: geral e planos fixos](./REPOR-003.md)
- [Atividade de clientes por mês e ano](./REPOR-004.md)
- [Dashboard de negócio](./REPOR-005.md)
- [Aparelhos utilizados](./REPOR-006.md)
- [Relatório de prospecções](./REPOR-007.md)
- [Estrutura modular e convenções do repositório](./CONVENCOES_REPOSITORIO.md)
- [Design de referência](../stitch_gest_o_cl_nica_integrada/clinical_serenity/DESIGN.md)

## Como usar

1. Antes de iniciar uma tarefa, conferir suas dependências no backlog.
2. Se uma decisão aprovada mudar, atualizar primeiro `DECISOES.md`.
3. Toda tarefa só é concluída quando atende aos critérios próprios e à Definição de Pronto global.
4. Dados reais de pacientes não podem ser usados antes do marco de produção segura.
5. O backlog é incremental: a primeira entrega executável é Dashboard + Agenda, não o sistema inteiro de uma vez.

## Estado atual

- Planejamento funcional: aprovado.
- Decisões principais: documentadas.
- Layout de referência: disponível em `stitch_gest_o_cl_nica_integrada`.
- Implementação do produto: `QA-001` concluída com Dashboard e Agenda validados em celular e desktop.
- Marco concluído: `M1 — Fundação e primeira versão navegável`.
- Fundação de dados: `DATA-001` e `DATA-002` concluídas, com esquema PostgreSQL recriável e seed sintético.
- Marco concluído: `M2 — Identidade, multiempresa e auditoria`.
- Identidade, multiempresa e segurança: `AUTH-001` a `AUTH-005`, `AUD-001` e `SEC-001` concluídas, com sessões opacas, MFA privilegiado, RBAC negado por padrão, RLS vinculada à membership ativa, eventos sensíveis append-only e riscos ligados a verificações futuras.
- Clientes: `CRM-001` a `CRM-004` concluídas com CRUD autorizado, regras operacionais, busca e paginação no servidor, perfil integrado por capacidade, RLS, auditoria e exclusão lógica.
- Prospecções: `LEAD-001` e `LEAD-002` concluídas com funil autorizado, contatos e interações, próximas ações e conversão transacional idempotente que preserva o histórico.
- Recursos operacionais: `RES-001` concluída com catálogos de modalidades, serviços, salas e aparelhos autorizados, isolados, auditados e associados à agenda.
- Agenda operacional: `SCH-001` a `SCH-006` concluídas com disponibilidade, agendamentos individuais, turmas, recorrências, recursos e controle de presença.
- Qualidade da agenda: `QA-002` concluída com provas em PostgreSQL real de disputa pela última vaga, preservação do horário local entre offsets e rollback atômico de recorrências.
- Área do cliente: `CLI-001` a `CLI-004` concluídas com shell exclusivo, escopo pelo titular, agendamentos próprios, check-in idempotente, conteúdo clínico publicado e canais oficiais da clínica.
- Fila de interesse: `WAIT-001` a `WAIT-003` concluídas com ordem transacional, oferta temporária única, expiração, confirmação atômica por plano ou crédito, revalidação de capacidade e conflito, auditoria e Outbox idempotente.
- Reposições: `REP-001` e `REP-002` concluídas com emissão por origem elegível, saldo derivado, validade, histórico imutável e agendamento próprio com consumo atômico.
- Push: `PUSH-001` e `PUSH-002` concluídas com token cifrado e revogável, preferências por clínica, template sem dados sensíveis e entrega FCM por Outbox com lease, retentativa e deduplicação persistente.
- Marco concluído: `M4 — Área do cliente, interesse, push e reposições`.
- Financeiro: `FIN-001` a `FIN-004` concluídas com contas a receber e pagar recorrentes, pagamentos parciais, baixas, estornos append-only, categorias, saldo derivado, autorização, RLS e auditoria.
- Qualidade financeira: `QA-003` concluída com reconciliação entre livro-razão, views de saldo, estados efetivos e resumos, incluindo geração contratual idempotente.
- Relatórios: `REPOR-001` a `REPOR-007` concluídas com filtros compartilhados, paginação, CSV seguro e visões conciliadas de aniversariantes, clientes, atividade, negócio, aparelhos e funil de prospecções.
