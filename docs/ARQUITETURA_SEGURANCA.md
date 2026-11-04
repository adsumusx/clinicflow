# Arquitetura, dados e segurança

## 1. Contexto

O ClinicFlow é um sistema operacional para clínicas e profissionais de Pilates, fisioterapia e atendimento médico. Ele processará dados cadastrais, financeiros, fiscais e dados pessoais sensíveis de saúde.

A arquitetura precisa privilegiar:

- isolamento entre clínicas;
- consistência de agenda e financeiro;
- rastreabilidade;
- uso seguro no celular;
- integrações assíncronas confiáveis;
- evolução do site para aplicativo Android sem duplicar o produto.

## 2. Visão dos componentes

```text
Web/PWA ───────┐
               ├── API autenticada ── Serviços de domínio ── PostgreSQL
Android ───────┘          │                    │                 │
                          │                    ├── Fila/Outbox ──┼── Push/Email
                          │                    ├── NFS-e Adapter ├── Prefeitura/Gateway
                          │                    └── Arquivos      └── Storage privado
                          └── Auditoria/Observabilidade
```

### Interface

- Aplicação responsiva React/TypeScript.
- Navegação inferior no celular e lateral/superior no desktop.
- Componentes acessíveis e reutilizáveis.
- PWA para instalação pelo navegador.
- Capacitor para empacotamento Android e acesso a recursos nativos.

### Backend

- Endpoints e ações autenticados no servidor.
- Serviços separados por domínio dentro de um monólito modular inicial.
- Esquemas compartilhados de validação.
- Operações críticas dentro de transações.
- Processamento assíncrono com padrão Outbox para evitar perda de eventos.

### Dados

- PostgreSQL gerenciado.
- `organization_id` obrigatório em toda entidade pertencente à clínica.
- RLS como segunda barreira, além das verificações do backend.
- Chaves estrangeiras, restrições e índices definidos no banco.
- Valores monetários em centavos, nunca em ponto flutuante.
- Datas armazenadas com fuso/instante explícito; exibição inicial em `America/Sao_Paulo`.

## 3. Domínios e entidades principais

### Identidade e organização

- `organizations`
- `units`
- `users`
- `memberships`
- `roles` e `permissions`
- `sessions`, `trusted_devices` e `push_devices`

### CRM e atendimento

- `clients`
- `client_contacts`
- `client_consents`
- `prospects`
- `prospect_interactions`
- `professionals`
- `clinical_records`
- `assessments`
- `workout_plans`

### Agenda

- `services`
- `modalities`
- `rooms`
- `equipment`
- `availability_rules`
- `recurrence_rules`
- `appointments`
- `appointment_participants`
- `appointment_equipment`
- `waitlist_entries`
- `waitlist_offers`
- `checkins`
- `replacement_credits`

### Financeiro e fiscal

- `plans`
- `contracts`
- `receivables`
- `payables`
- `payments`
- `financial_categories`
- `fiscal_documents`
- `fiscal_attempts`
- `fiscal_events`

### Plataforma

- `notifications`
- `notification_preferences`
- `outbox_events`
- `files`
- `file_links`
- `audit_events`

O modelo conceitual, incluindo relações, propriedade e classificação dos dados, está formalizado em [`DATA-001.md`](./DATA-001.md). O esquema físico, as migrations reversíveis, a RLS e o seed sintético foram implementados em [`DATA-002.md`](./DATA-002.md), ainda sem conectar telas a dados reais.

Os ativos, adversários, fluxos entre fronteiras de confiança e ameaças priorizadas estão no modelo [`SEC-001.md`](./SEC-001.md). Os IDs de ameaça desse documento devem acompanhar os testes e revisões de segurança das tarefas futuras.

## 4. Regras de consistência críticas

### Agenda

- A capacidade deve ser verificada e ocupada na mesma transação.
- O banco deve impedir duplicidade de participante no mesmo agendamento.
- Profissional, sala e aparelho não podem ter conflitos incompatíveis.
- Séries recorrentes precisam permitir alteração de uma ocorrência ou da série futura.
- Mudança de capacidade deve reavaliar a fila de interesse.

### Lista de interesse

- Apenas um interesse ativo por cliente e horário.
- Ordem definida pela criação do interesse.
- Somente uma oferta ativa por vaga na estratégia sequencial.
- Oferta possui expiração e consumo atômico.
- Confirmação revalida capacidade, conflito, plano e crédito.
- Cancelamento confirmado gera evento Outbox; a entrega de push não participa da transação principal.

### Financeiro

- Recebimentos e pagamentos liquidados não são apagados.
- Correções usam estorno, cancelamento ou lançamento compensatório.
- Pagamentos parciais preservam saldo e histórico.
- Totais de dashboard e relatórios derivam dos mesmos lançamentos.
- Toda operação externa usa chave de idempotência.

### NFS-e

- Estado mínimo: rascunho, aguardando envio, processando, autorizada, rejeitada, cancelamento pendente, cancelada e erro de integração.
- Uma cobrança não pode gerar duas notas autorizadas equivalentes.
- XML e PDF ficam privados e vinculados ao histórico fiscal.
- Credenciais e certificados nunca são expostos ao navegador.
- Respostas externas são validadas e armazenadas sem segredos.

## 5. Matriz inicial de acesso

| Recurso | Proprietário/Admin | Profissional | Recepção/Financeiro | Cliente |
| --- | --- | --- | --- | --- |
| Configuração da clínica | Total | Não | Não | Não |
| Agenda da equipe | Total | Conforme vínculo | Operacional | Somente própria |
| Dados cadastrais | Total | Conforme atendimento | Operacional | Somente próprios |
| Prontuário/avaliações | Configurável | Conforme atendimento | Bloqueado por padrão | Somente conteúdo liberado |
| Contas a receber/pagar | Total | Resumo opcional | Total conforme função | Somente faturas próprias |
| NFS-e | Total | Não por padrão | Conforme permissão | Somente documento próprio liberado |
| Auditoria | Total restrito | Não | Não | Não |

A matriz foi traduzida em permissões granulares e testes automatizados em [`AUTH-003`](./AUTH-003.md). “Admin” não recebe acesso automático a conteúdo clínico; essa capacidade é bloqueada por padrão.

## 6. Controles de segurança obrigatórios

### Identidade e sessão

- MFA TOTP obrigatório para contas privilegiadas, implementado em [`AUTH-005`](./AUTH-005.md), sem sessão completa antes do segundo fator.
- Senhas tratadas por provedor de identidade confiável; nunca armazenadas diretamente pela aplicação.
- Cookies `Secure`, `HttpOnly` e `SameSite` quando aplicável.
- Rotação, revogação e expiração de sessões.
- Respostas de autenticação que não permitam enumerar usuários.
- Limite de tentativas e detecção de acesso anômalo.

### Autorização e isolamento

- Organização e identidade obtidas da sessão, nunca aceitas como autoridade a partir do cliente.
- Política de negação por padrão.
- RLS em tabelas multiempresa.
- Testes negativos para cada endpoint: outro usuário, outra função e outra clínica.
- Acesso a dados clínicos separado de acesso administrativo e financeiro.

### Aplicação e API

- Validação estrutural e de negócio no servidor.
- Consultas parametrizadas.
- Proteções contra XSS, CSRF, SSRF, clickjacking e abuso de upload.
- CSP restritiva, TLS e cabeçalhos de segurança.
- Rate limiting por usuário, IP e operação sensível.
- Webhooks verificados por assinatura, timestamp e idempotência.
- Erros apresentados sem stack trace, SQL, tokens ou dados pessoais.

### Dados e arquivos

- Classificação: público, interno, pessoal, sensível e segredo.
- Criptografia em trânsito e repouso.
- Campos ou documentos de maior risco podem receber criptografia adicional por aplicação.
- Buckets privados e links temporários com expiração.
- Antivírus e validação de tipo/tamanho para uploads.
- Proibição de dados sensíveis em logs, métricas, URLs e analytics.
- Backups cifrados, retenção definida e teste periódico de restauração.

### Operação e desenvolvimento

- Ambientes e credenciais separados.
- Segredos gerenciados fora do repositório.
- Dependências com versão controlada e verificação de vulnerabilidades.
- Revisão obrigatória de migrations e alterações de autorização.
- SAST, testes de segurança, varredura de dependências e pentest antes da produção.
- Logs de auditoria com ator, clínica, ação, alvo, instante e metadados mínimos.
- Plano de resposta a incidente e canal LGPD definidos antes de dados reais.

## 7. Privacidade e LGPD

Antes da produção devem existir:

- inventário das operações de tratamento;
- definição de controlador, operadores, suboperadores e canal de atendimento;
- finalidade e base legal por categoria de dado;
- termos, política de privacidade e registros de consentimento quando aplicável;
- política de retenção por tipo de registro;
- fluxo de acesso, correção, portabilidade, anonimização e eliminação quando cabível;
- avaliação de impacto para funções de maior risco;
- contrato e análise dos fornecedores que processam dados;
- procedimento de avaliação e comunicação de incidentes.

Requisitos de prontuário e retenção devem ser validados com assessoria jurídica e com o conselho profissional aplicável ao estabelecimento.

## 8. Ambientes e hospedagem

### Desenvolvimento

- Dados sintéticos.
- Integrações simuladas.
- Sem certificados ou credenciais produtivas.

### Homologação

- Dados fictícios representativos.
- Testes de push, concorrência e integrações em sandbox.
- Acesso restrito à equipe.

### Produção

- Plano pago e contrato compatível com a criticidade dos dados.
- Domínio e TLS próprios.
- Backups, restauração, alertas e monitoração.
- Menor privilégio para acessos administrativos.
- Processo de implantação reversível.

## 9. Portões de qualidade

Uma versão não avança para produção se houver:

- vulnerabilidade crítica ou alta conhecida sem mitigação aprovada;
- falha de isolamento entre clínicas;
- possibilidade reproduzível de overbooking;
- divergência entre lançamentos e relatórios financeiros;
- emissão fiscal duplicável;
- ausência de backup restaurável;
- segredos no código, log ou pacote do navegador;
- ausência dos documentos mínimos de privacidade;
- fluxo principal inacessível por teclado ou impraticável no celular.
