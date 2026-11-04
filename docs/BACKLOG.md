# Roadmap e backlog de implementação

## 1. Convenções

Estados sugeridos:

- `Pendente`: ainda não iniciada.
- `Pronta`: dependências atendidas e pode ser executada.
- `Em andamento`: existe responsável trabalhando.
- `Em revisão`: implementação concluída, aguardando validação.
- `Concluída`: critérios de aceite e Definição de Pronto atendidos.
- `Bloqueada`: depende de decisão, credencial ou serviço externo.

Prioridades:

- `P0`: necessária para segurança, consistência ou caminho principal.
- `P1`: necessária para o primeiro lançamento utilizável.
- `P2`: melhoria importante que pode vir depois do núcleo.

## 2. Marcos

| Marco | Resultado |
| --- | --- |
| M0 | Decisões, arquitetura e backlog aprovados |
| M1 | Fundação e primeira versão navegável de Dashboard + Agenda |
| M2 | Autenticação, organizações, usuários e auditoria |
| M3 | Clientes, prospecções e agenda operacional |
| M4 | Área do cliente, check-in, interesse, push e reposições |
| M5 | Financeiro completo |
| M6 | Relatórios |
| M7 | NFS-e homologada para a clínica piloto |
| M8 | Aplicativo Android pronto para Play Store |
| M9 | Produção segura e lançamento controlado |

## 3. Backlog por marco

### M0 — Planejamento

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| DOC-001 | P0 | Registrar decisões aprovadas | — | `DECISOES.md` revisado e versionado. |
| DOC-002 | P0 | Registrar arquitetura e controles de segurança | DOC-001 | Limites, dados, regras críticas e portões de qualidade documentados. |
| DOC-003 | P0 | Criar backlog executável | DOC-001 | Tarefas possuem IDs, dependências e aceite. |
| NEG-001 | P1 | Confirmar nome, marca e domínio | — | Nome e ativos aprovados ou decisão explícita de manter marca provisória. |

### M1 — Fundação e primeira versão navegável

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| DEV-001 | P0 | Inicializar a aplicação web com TypeScript e componentes-base | DOC-003 | Projeto inicia, compila e preserva os arquivos Stitch como referência. |
| DEV-002 | P0 | Definir estrutura modular e padrões do repositório | DEV-001 | Pastas, imports, scripts e convenções documentados sem duplicidade de bibliotecas. |
| DES-001 | P0 | Converter Clinical Serenity em tokens globais | DEV-001 | Cores, tipografia, espaçamento, sombras e raios funcionam em mobile e desktop. |
| DES-002 | P1 | Criar shell responsivo profissional | DES-001 | Navegação inferior no celular e navegação adequada no desktop, com estados ativos acessíveis. |
| UI-001 | P1 | Implementar Dashboard demonstrativo | DES-002 | Indicadores, agenda do dia, pendências, leads, receita e aniversariantes seguem o Stitch. |
| UI-002 | P0 | Implementar Agenda demonstrativa | DES-002 | Dias, horários, turma lotada, vagas, interesse e novo agendamento aparecem com dados realistas. |
| UI-003 | P1 | Criar estados compartilhados | UI-001, UI-002 | Loading, vazio, erro e sucesso possuem componentes consistentes. |
| QA-001 | P0 | Validar primeira versão navegável | UI-003 | Compila sem erro e fluxos principais são reconhecíveis em celular e desktop. |

### M2 — Identidade, multiempresa e auditoria

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| DATA-001 | P0 | Criar diagrama de dados inicial | DOC-002 | Entidades, relações, propriedade e dados sensíveis identificados. |
| DATA-002 | P0 | Configurar PostgreSQL, migrations e dados sintéticos | DATA-001, DEV-002 | Banco pode ser recriado do zero com seed seguro. |
| AUTH-001 | P0 | Implementar cadastro, login, recuperação e encerramento de sessão | DATA-002 | Fluxos funcionam sem revelar existência de contas. |
| AUTH-002 | P0 | Implementar organização e memberships | AUTH-001 | Usuário só acessa organizações das quais participa. |
| AUTH-003 | P0 | Implementar RBAC granular | AUTH-002 | Matriz de acesso está representada e negada por padrão. |
| AUTH-004 | P0 | Implementar RLS e testes entre clínicas | AUTH-002 | Tentativas cruzadas falham no backend e no banco. |
| AUTH-005 | P0 | Implementar MFA para contas privilegiadas | AUTH-001 | Admin/proprietário não conclui acesso privilegiado sem segundo fator. |
| AUD-001 | P0 | Implementar trilha de auditoria | AUTH-003 | Alterações sensíveis registram ator, clínica, ação, alvo e instante. |
| SEC-001 | P0 | Produzir modelo de ameaças inicial | DATA-001 | Ativos, fronteiras, ameaças e mitigações estão ligados a tarefas verificáveis. |

### M3 — Clientes, prospecções e agenda operacional

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| CRM-001 | P0 | CRUD seguro de clientes | AUTH-004 | Cadastro valida dados, duplicidades e isolamento; exclusão é lógica. |
| CRM-002 | P0 | Implementar tipo fixo/rotativo | CRM-001 | Tipo altera regras de plano, recorrência e filtros. |
| CRM-003 | P1 | Implementar busca, filtros e paginação | CRM-001 | Busca por nome/contato funciona sem carregar toda a base. |
| CRM-004 | P1 | Implementar perfil e histórico do cliente | CRM-001, AUD-001 | Perfil reúne agenda, plano, financeiro e histórico permitido à função. |
| CRM-005 | P0 | Gestão de contratos e planos do cliente | CRM-004, FIN-001 | Permite criar, listar e gerenciar contratos, atualizando o cliente fixo e auditoria. |
| LEAD-001 | P1 | Implementar funil de prospecções | AUTH-004 | Lead possui etapa, origem, responsável, contatos e próxima ação. |
| LEAD-002 | P1 | Converter prospecção em cliente | LEAD-001, CRM-001 | Conversão é idempotente e mantém o histórico. |
| RES-001 | P1 | Cadastrar serviços, modalidades, salas e aparelhos | AUTH-003 | Recursos podem ser ativados, inativados e associados à agenda. |
| SCH-001 | P0 | Implementar disponibilidade e bloqueios | RES-001 | Férias, intervalos, indisponibilidade e horários profissionais são respeitados. |
| SCH-002 | P0 | Implementar agendamento individual | SCH-001, CRM-001 | Criar, alterar e cancelar valida conflitos e permissões. |
| SCH-003 | P0 | Implementar turmas e capacidade | SCH-002 | Operações concorrentes nunca ultrapassam a capacidade. |
| SCH-004 | P0 | Implementar recorrências e cliente fixo | SCH-002, CRM-002 | Série pode ser criada e uma ocorrência ou futuro da série pode ser alterado. |
| SCH-005 | P1 | Associar salas e aparelhos | SCH-002, RES-001 | Conflitos configurados são detectados e relatados. |
| SCH-006 | P1 | Registrar presença, falta e cancelamento | SCH-002 | Estados têm regras válidas, histórico e auditoria. |
| QA-002 | P0 | Testar concorrência e fusos da agenda | SCH-003, SCH-004 | Testes cobrem reserva simultânea, horário de verão/fuso e recorrência. |

### M4 — Área do cliente, interesse, push e reposições

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| CLI-001 | P0 | Criar shell e início da área do cliente | AUTH-003, DES-001 | Cliente vê somente seus dados e ações disponíveis. |
| CLI-002 | P0 | Implementar meus agendamentos e check-in | CLI-001, SCH-006 | Check-in respeita janela, sessão e política da clínica. |
| WAIT-001 | P0 | Criar fila de interesse | SCH-003, CLI-001 | Só existe um interesse ativo por cliente/horário e a ordem é preservada. |
| WAIT-002 | P0 | Criar oferta temporária de vaga | WAIT-001 | Uma vaga gera uma oferta ativa, expira e avança corretamente. |
| PUSH-001 | P0 | Integrar FCM e preferências | AUTH-001 | Token pode ser registrado/revogado; mensagens não contêm dados sensíveis. |
| PUSH-002 | P0 | Disparar push por evento Outbox | PUSH-001, WAIT-002 | Evento é entregue com retentativa e sem duplicar a oferta. |
| WAIT-003 | P0 | Confirmar vaga oferecida | WAIT-002 | Confirmação concorrente revalida capacidade, plano, crédito e conflito. |
| REP-001 | P0 | Implementar créditos de reposição | SCH-006, NEG-002 | Crédito registra origem, saldo, validade e consumo. |
| REP-002 | P1 | Agendar usando reposição | REP-001, CLI-002 | Uso é atômico e não permite saldo negativo ou crédito vencido. |
| CLI-003 | P1 | Exibir treinos e avaliações liberadas | CLI-001, CRM-004 | Cliente acessa somente conteúdos publicados para ele. |
| CLI-004 | P1 | Implementar Contato | CLI-001, NEG-005 | Canal aprovado abre/conclui contato sem expor dados de terceiros. |

### M5 — Financeiro

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| FIN-001 | P0 | Definir regras e modelo financeiro | NEG-007, DATA-001 | Estados, valores, vencimento, estorno e pagamento parcial estão formalizados. |
| FIN-002 | P0 | Implementar contas a receber | FIN-001, CRM-001 | CRUD, recorrência, vencimento, saldo e histórico conciliam. |
| FIN-003 | P0 | Implementar recebimentos e estornos | FIN-002 | Pagamentos parciais e estornos preservam histórico e saldo correto. |
| FIN-004 | P0 | Implementar contas a pagar | FIN-001 | Despesas, categorias, recorrências e baixas funcionam com auditoria. |
| FIN-005 | P1 | Gerar recebíveis por plano/contrato | FIN-002, SCH-004 | Geração é idempotente e respeita competência e vencimento. |
| FIN-006 | P0 | Exibir faturas abertas ao cliente | FIN-002, CLI-001 | Cliente vê somente cobranças próprias, valores e situação corretos. |
| FIN-007 | P1 | Implementar lembretes de cobrança | FIN-002, PUSH-002 | Política evita excesso de mensagens e registra entregas. |
| QA-003 | P0 | Testar reconciliação financeira | FIN-003, FIN-004, FIN-005 | Soma de lançamentos, saldos e resumos coincide em cenários de estorno/parcial. |

### M6 — Relatórios

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| REPOR-001 | P1 | Criar infraestrutura de filtros e exportação | CRM-003, FIN-004 | Período, unidade, profissional e situação são consistentes entre relatórios. |
| REPOR-002 | P1 | Relatório de aniversariantes | REPOR-001 | Lista por período respeita permissões e preferências de contato. |
| REPOR-003 | P1 | Clientes: geral e planos fixos | REPOR-001, CRM-002 | Totais e detalhes coincidem com a base filtrada. |
| REPOR-004 | P1 | Clientes: mês e ano | REPOR-001, SCH-006 | Atividade mensal/anual possui regra documentada e drill-down. |
| REPOR-005 | P1 | Dashboard de negócio | REPOR-001, QA-003 | Indicadores financeiros e operacionais usam fontes conciliadas. |
| REPOR-006 | P1 | Aparelhos utilizados | REPOR-001, SCH-005 | Uso por período/modalidade deriva dos agendamentos realizados. |
| REPOR-007 | P1 | Prospecções | REPOR-001, LEAD-002 | Conversão, origem, etapa, perdas e tempo de ciclo são calculados. |

### M7 — NFS-e Navegantes

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| NFS-001 | P0 | Confirmar emissor e requisitos da clínica piloto | NEG-006 | Prefeitura/contador confirmam ambiente, credenciais, códigos e documentação. |
| NFS-002 | P0 | Executar prova técnica de homologação | NFS-001 | Uma emissão fictícia completa o ciclo no ambiente de teste ou o bloqueio é documentado. |
| NFS-003 | P0 | Implementar interface de provedor fiscal | NFS-002 | Domínio não depende de tipos específicos do fornecedor. |
| NFS-004 | P0 | Implementar emissão assíncrona e idempotente | NFS-003, FIN-003 | Repetir requisição não duplica nota e estado pode ser retomado. |
| NFS-005 | P0 | Implementar consulta e reconciliação | NFS-004 | Estados locais convergem com o provedor e divergências são sinalizadas. |
| NFS-006 | P1 | Implementar PDF/XML privados | NFS-004 | Arquivos têm controle de acesso e links temporários. |
| NFS-007 | P1 | Implementar cancelamento/substituição | NFS-005 | Fluxo respeita regras do provedor, auditoria e estados financeiros. |
| NFS-008 | P0 | Implementar contingência e operação manual | NFS-005 | Falha externa não bloqueia o financeiro e pode ser reprocessada com segurança. |
| QA-004 | P0 | Homologar cenários fiscais | NFS-006, NFS-007, NFS-008 | Sucesso, rejeição, timeout, repetição e cancelamento foram testados. |

### M8 — Android e Play Store

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| AND-001 | P1 | Configurar Capacitor e pacote Android | CLI-002, PUSH-001 | Aplicativo abre a versão autenticada sem barra do navegador. |
| AND-002 | P1 | Integrar push nativo | AND-001, PUSH-001 | Recebe push, abre a rota correta e respeita logout/preferências. |
| AND-003 | P1 | Criar ícones, splash e identidade final | AND-001, NEG-001 | Ativos atendem formatos da Play Store e combinam com o produto. |
| AND-004 | P0 | Configurar assinatura e gestão segura de chaves | AND-001 | Chaves não entram no repositório e processo de recuperação está documentado. |
| AND-005 | P0 | Configurar associação segura domínio/aplicativo | AND-004 | Links verificados abrem no aplicativo correto. |
| AND-006 | P0 | Preparar privacidade e Data Safety | NEG-008, LGPD-001 | Declarações correspondem exatamente aos dados e SDKs usados. |
| AND-007 | P0 | Gerar e testar release AAB | AND-002, AND-003, AND-004, AND-005 | Release assinada funciona em dispositivos suportados e atende API alvo vigente. |

### M9 — Produção segura

| ID | Pri. | Tarefa | Dependências | Critério de aceite |
| --- | --- | --- | --- | --- |
| OPS-001 | P0 | Contratar/configurar infraestrutura de produção | QA-004 | Ambientes, domínio, TLS, segredos e menor privilégio configurados. |
| OPS-002 | P0 | Configurar backups e executar restauração | OPS-001 | Restauração completa é comprovada e documentada. |
| OPS-003 | P0 | Configurar observabilidade e alertas | OPS-001 | Erros, indisponibilidade e falhas de fila/fiscal geram alertas sem dados sensíveis. |
| LGPD-001 | P0 | Formalizar inventário, políticas e canal do titular | NEG-008 | Documentação e processo operacional aprovados pelo responsável. |
| SEC-002 | P0 | Executar revisão de autorização e isolamento | QA-004 | Testes negativos e revisão não encontram acesso cruzado conhecido. |
| SEC-003 | P0 | Executar análise de dependências, SAST e secrets scan | QA-004 | Não há achado crítico/alto sem mitigação aprovada. |
| SEC-004 | P0 | Executar pentest antes do lançamento | SEC-002, SEC-003, OPS-001 | Achados críticos/altos corrigidos e retestados. |
| QA-005 | P0 | Testes ponta a ponta dos fluxos principais | QA-004, AND-007 | Profissional e cliente concluem cenários definidos sem erro bloqueante. |
| QA-006 | P0 | Validar acessibilidade e dispositivos | AND-007 | Caminhos principais funcionam por teclado, leitor de tela básico e celulares alvo. |
| REL-001 | P0 | Executar lançamento controlado com clínica piloto | OPS-002, OPS-003, LGPD-001, SEC-004, QA-005 | Checklist aprovado, rollback pronto e monitoramento ativo. |

## 4. Dependências externas

Tarefas bloqueáveis por terceiros:

- Marca, domínio e conta de desenvolvedor Google Play.
- Conta Firebase e configuração do projeto Android.
- Credenciais e documentação fiscal da Prefeitura/provedor.
- Validação de códigos fiscais pela contabilidade.
- Decisões jurídicas e operacionais de LGPD.
- Regras comerciais de cobrança, cancelamento e reposição.

Nenhuma credencial deve ser adicionada a documentos, issues, mensagens ou commits.

## 5. Definição de Pronto global

Uma tarefa de implementação só está concluída quando, conforme aplicável:

- o comportamento atende ao critério de aceite;
- autorização e isolamento foram validados no servidor;
- entradas e respostas são validadas;
- estados de loading, vazio, erro e sucesso existem;
- interface funciona no celular e desktop;
- acessibilidade básica de teclado, foco, rótulos e contraste foi conferida;
- testes relevantes foram adicionados e executados;
- logs não contêm dados pessoais ou segredos;
- migrations são reversíveis ou têm estratégia de recuperação;
- documentação e decisões afetadas foram atualizadas;
- não existe vulnerabilidade crítica ou alta conhecida sem mitigação aprovada.

## 6. Próxima tarefa recomendada

Os marcos `M1` a `M4`, as tarefas `FIN-001` a `FIN-004` e `REPOR-001` a `REPOR-007` foram concluídos. A infraestrutura e os relatórios entregues estão documentados em [`REPOR-001.md`](./REPOR-001.md), [`REPOR-002.md`](./REPOR-002.md), [`REPOR-003.md`](./REPOR-003.md), [`REPOR-004.md`](./REPOR-004.md), [`REPOR-005.md`](./REPOR-005.md), [`REPOR-006.md`](./REPOR-006.md) e [`REPOR-007.md`](./REPOR-007.md). A próxima tarefa recomendada é `NFS-001`, a confirmação do emissor e dos requisitos fiscais da clínica piloto.
