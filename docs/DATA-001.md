# DATA-001 — Diagrama de dados inicial

> Estado: **Concluída**. Revisão: 2026-09-01.
>
> Este é o modelo conceitual que orientará `DATA-002`. Nomes, tipos e restrições ainda serão confirmados nas migrations, sem enfraquecer as invariantes de propriedade, isolamento e histórico definidas aqui.

## 1. Legenda e invariantes

Classificação usada no documento:

| Marca | Classe | Exemplos | Regra mínima |
| --- | --- | --- | --- |
| `PUB` | Público | nome comercial, modalidades divulgadas | Pode ser publicado somente quando houver intenção explícita. |
| `INT` | Interno | capacidade, regras, identificadores técnicos | Disponível apenas a pessoas autenticadas e autorizadas. |
| `PES` | Pessoal | nome, contato, nascimento, identificadores | Acesso por necessidade, retenção definida e proibição em logs/URLs. |
| `SEN` | Pessoal sensível | prontuário, avaliação, condição de saúde, treino terapêutico | Autorização clínica separada, auditoria e proteção reforçada. |
| `SEG` | Segredo | token de sessão, token push, credencial fiscal | Nunca retorna ao cliente após cadastro; criptografia ou hash específico e rotação. |

Invariantes do modelo:

1. Todo dado de negócio contém `organization_id NOT NULL`, inclusive tabelas filhas. A coluna não é derivada de um valor enviado pelo navegador: vem do contexto autenticado e participa das políticas RLS.
2. `users`, `permissions`, `sessions`, `trusted_devices` e `push_devices` são dados de plataforma e não pertencem a uma clínica. O acesso a uma clínica sempre passa por `memberships`.
3. Chaves primárias são UUIDs. Tabelas mutáveis possuem `created_at`, `updated_at` e, quando a exclusão for permitida, `deleted_at`. Instantes usam `timestamptz`; a unidade mantém seu fuso IANA para exibição.
4. Valores monetários usam inteiros em centavos e código ISO de moeda. Pagamentos, eventos fiscais, auditoria e lançamentos consumidos não são apagados.
5. Relações entre tabelas multiempresa usam FKs compostas ou restrições equivalentes incluindo `organization_id`, para que uma FK válida não possa atravessar clínicas.
6. Dados `SEN` e `SEG` não entram em logs, analytics, URLs, notificações push ou armazenamento local. Arquivos são privados e entregues por autorização e link temporário.
7. Identidade (`users`), pessoa atendida (`clients`) e vínculo profissional (`professionals`) são conceitos diferentes. Um cliente ou profissional pode ganhar acesso ao portal por `user_id`, mas o cadastro operacional não depende disso.

## 2. Visão de propriedade

| Proprietário / escopo | Entidades | Observação |
| --- | --- | --- |
| Plataforma | `users`, `permissions`, `sessions`, `trusted_devices`, `push_devices` | Não contêm dados de negócio de uma clínica. |
| Organização | `organizations` | Raiz do tenant; apenas operações administrativas de plataforma podem atravessar tenants. |
| Organização | `units`, `roles`, `memberships`, `clients`, `professionals`, `prospects`, `services`, `modalities`, `plans`, `financial_categories` | Raízes funcionais sempre filtradas por `organization_id`. |
| Organização, por meio da raiz funcional | contatos, consentimentos, registros clínicos, avaliações, treinos, interações, contratos, agenda, fila, créditos, financeiro, fiscal e arquivos | A entidade filha repete o mesmo `organization_id` da raiz; divergência deve falhar no banco. |
| Organização e destinatário | `notifications`, `notification_preferences` | Preferências são por usuário e clínica; revogar membership encerra o acesso naquele tenant. |
| Organização, append-only | `audit_events`, `outbox_events` | Ator pode ser nulo em ações do sistema, mas clínica e alvo permanecem obrigatórios. |

## 3. Identidade, organização e autorização

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ UNITS : possui
    ORGANIZATIONS ||--o{ ROLES : define
    ORGANIZATIONS ||--o{ MEMBERSHIPS : admite
    USERS ||--o{ MEMBERSHIPS : participa
    ROLES ||--o{ MEMBERSHIPS : atribuido_a
    ROLES ||--o{ ROLE_PERMISSIONS : concede
    PERMISSIONS ||--o{ ROLE_PERMISSIONS : compoe
    USERS ||--o{ SESSIONS : autentica
    USERS ||--o{ TRUSTED_DEVICES : reconhece
    USERS ||--o{ PUSH_DEVICES : recebe_push
    MEMBERSHIPS o|--o| PROFESSIONALS : habilita

    ORGANIZATIONS {
        uuid id PK
        string legal_name "PES"
        string trade_name "PUB"
        string tax_id "PES"
        string status "INT"
        timestamptz deleted_at "INT"
    }
    UNITS {
        uuid id PK
        uuid organization_id FK
        string name "PUB"
        string timezone "INT"
        string address "PES"
        boolean active "INT"
    }
    USERS {
        uuid id PK
        string identity_provider_subject "SEG"
        string email_normalized "PES"
        string status "INT"
        timestamptz last_login_at "PES"
    }
    ROLES {
        uuid id PK
        uuid organization_id FK
        string code "INT"
        string name "INT"
        boolean privileged "INT"
    }
    PERMISSIONS {
        uuid id PK
        string code "INT"
        string description "INT"
    }
    ROLE_PERMISSIONS {
        uuid organization_id FK
        uuid role_id FK
        uuid permission_id FK
    }
    MEMBERSHIPS {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        uuid role_id FK
        string status "INT"
        timestamptz revoked_at "INT"
    }
    PROFESSIONALS {
        uuid id PK
        uuid organization_id FK
        uuid membership_id FK
        string display_name "PES"
        string registration_number "PES"
        string specialties "INT"
        boolean active "INT"
    }
    SESSIONS {
        uuid id PK
        uuid user_id FK
        string token_hash "SEG"
        timestamptz expires_at "SEG"
        timestamptz revoked_at "SEG"
    }
    TRUSTED_DEVICES {
        uuid id PK
        uuid user_id FK
        string device_fingerprint_hash "SEG"
        string label "PES"
        timestamptz trusted_until "SEG"
    }
    PUSH_DEVICES {
        uuid id PK
        uuid user_id FK
        string platform "INT"
        string token_ciphertext "SEG"
        string token_fingerprint "SEG"
        timestamptz revoked_at "SEG"
        timestamptz last_seen_at "PES"
    }
```

Restrições principais:

- `memberships`: único vínculo ativo por `(organization_id, user_id)`; troca de papel preserva histórico auditável.
- Papéis iniciais: proprietário, administrador, profissional, recepção/financeiro e cliente. Permissões são negadas por padrão; acesso clínico não decorre automaticamente de ser administrador.
- `professionals.membership_id` é opcional e único. Assim, um profissional pode existir na agenda antes de aceitar acesso ao sistema.
- E-mail não concede acesso a uma clínica e não substitui o vínculo em `memberships`.

## 4. CRM e atendimento clínico

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ CLIENTS : possui
    USERS o|--o{ CLIENTS : acessa_opcionalmente
    CLIENTS ||--o{ CLIENT_CONTACTS : informa
    CLIENTS ||--o{ CLIENT_CONSENTS : registra
    CLIENTS ||--o{ CLINICAL_RECORDS : possui
    PROFESSIONALS ||--o{ CLINICAL_RECORDS : escreve
    CLIENTS ||--o{ ASSESSMENTS : realiza
    PROFESSIONALS ||--o{ ASSESSMENTS : avalia
    CLIENTS ||--o{ WORKOUT_PLANS : recebe
    PROFESSIONALS ||--o{ WORKOUT_PLANS : prescreve
    ORGANIZATIONS ||--o{ PROSPECTS : possui
    PROFESSIONALS o|--o{ PROSPECTS : responsavel
    PROSPECTS ||--o{ PROSPECT_INTERACTIONS : historico
    PROSPECTS o|--o| CLIENTS : converte_em

    CLIENTS {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        string full_name "PES"
        date birth_date "PES"
        string document_number "PES"
        string client_type "INT"
        string status "INT"
        timestamptz deleted_at "INT"
    }
    CLIENT_CONTACTS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        string type "PES"
        string value "PES"
        boolean preferred "PES"
    }
    CLIENT_CONSENTS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        string purpose "PES"
        string legal_basis "PES"
        timestamptz granted_at "PES"
        timestamptz revoked_at "PES"
        string evidence_ref "PES"
    }
    CLINICAL_RECORDS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        uuid author_professional_id FK
        string record_type "SEN"
        text content "SEN"
        timestamptz occurred_at "SEN"
        timestamptz signed_at "SEN"
    }
    ASSESSMENTS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        uuid professional_id FK
        string assessment_type "SEN"
        jsonb structured_data "SEN"
        string publication_status "SEN"
        timestamptz assessed_at "SEN"
    }
    WORKOUT_PLANS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        uuid professional_id FK
        string title "SEN"
        jsonb instructions "SEN"
        string publication_status "SEN"
        date valid_until "SEN"
    }
    PROSPECTS {
        uuid id PK
        uuid organization_id FK
        uuid owner_professional_id FK
        uuid converted_client_id FK
        string full_name "PES"
        string contact "PES"
        string stage "INT"
        string source "INT"
        timestamptz next_action_at "INT"
    }
    PROSPECT_INTERACTIONS {
        uuid id PK
        uuid organization_id FK
        uuid prospect_id FK
        string type "INT"
        text notes "PES"
        timestamptz occurred_at "PES"
    }
```

Regras principais:

- A conversão de prospect é idempotente: `converted_client_id` é único e mantém o histórico de origem.
- Registros assinados não são editados silenciosamente; correções criam nova versão/adendo e mantêm autoria e instante.
- `publication_status` controla o que pode aparecer no portal do cliente. Ser titular do dado não torna automaticamente toda anotação interna publicável.
- Campos clínicos definitivos e prazos de retenção dependem de `NEG-004` e validação jurídica/profissional. Até lá, migrations não devem criar coleta clínica ampla.

## 5. Agenda, recursos, presença e reposição

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ MODALITIES : oferece
    MODALITIES ||--o{ SERVICES : especializa
    UNITS ||--o{ ROOMS : possui
    UNITS ||--o{ EQUIPMENT : possui
    PROFESSIONALS ||--o{ AVAILABILITY_RULES : disponibiliza
    SERVICES ||--o{ APPOINTMENTS : classifica
    UNITS ||--o{ APPOINTMENTS : sedia
    PROFESSIONALS ||--o{ APPOINTMENTS : conduz
    ROOMS o|--o{ APPOINTMENTS : recebe
    RECURRENCE_RULES o|--o{ APPOINTMENTS : gera
    APPOINTMENTS ||--o{ APPOINTMENT_PARTICIPANTS : inclui
    CLIENTS ||--o{ APPOINTMENT_PARTICIPANTS : participa
    APPOINTMENTS ||--o{ APPOINTMENT_EQUIPMENT : reserva
    EQUIPMENT ||--o{ APPOINTMENT_EQUIPMENT : utilizado
    APPOINTMENT_PARTICIPANTS ||--o| CHECKINS : confirma
    APPOINTMENTS ||--o{ WAITLIST_ENTRIES : tem_fila
    CLIENTS ||--o{ WAITLIST_ENTRIES : solicita
    WAITLIST_ENTRIES ||--o{ WAITLIST_OFFERS : recebe
    APPOINTMENT_PARTICIPANTS ||--o{ REPLACEMENT_CREDITS : origina
    CLIENTS ||--o{ REPLACEMENT_CREDITS : possui
    APPOINTMENT_PARTICIPANTS o|--o| REPLACEMENT_CREDITS : consome

    MODALITIES {
        uuid id PK
        uuid organization_id FK
        string name "PUB"
        boolean active "INT"
    }
    SERVICES {
        uuid id PK
        uuid organization_id FK
        uuid modality_id FK
        string name "PUB"
        int duration_minutes "INT"
        int default_capacity "INT"
        boolean active "INT"
    }
    ROOMS {
        uuid id PK
        uuid organization_id FK
        uuid unit_id FK
        string name "INT"
        int capacity "INT"
        boolean active "INT"
    }
    EQUIPMENT {
        uuid id PK
        uuid organization_id FK
        uuid unit_id FK
        string name "INT"
        int quantity "INT"
        boolean active "INT"
    }
    AVAILABILITY_RULES {
        uuid id PK
        uuid organization_id FK
        uuid professional_id FK
        uuid unit_id FK
        string rule_type "INT"
        string recurrence_expression "INT"
        timestamptz starts_at "INT"
        timestamptz ends_at "INT"
    }
    RECURRENCE_RULES {
        uuid id PK
        uuid organization_id FK
        string recurrence_expression "INT"
        date series_start "INT"
        date series_end "INT"
        string timezone "INT"
    }
    APPOINTMENTS {
        uuid id PK
        uuid organization_id FK
        uuid unit_id FK
        uuid service_id FK
        uuid professional_id FK
        uuid room_id FK
        uuid recurrence_rule_id FK
        timestamptz starts_at "PES"
        timestamptz ends_at "PES"
        int capacity "INT"
        string status "PES"
    }
    APPOINTMENT_PARTICIPANTS {
        uuid id PK
        uuid organization_id FK
        uuid appointment_id FK
        uuid client_id FK
        string status "PES"
        string cancellation_reason "PES"
        timestamptz booked_at "PES"
    }
    APPOINTMENT_EQUIPMENT {
        uuid organization_id FK
        uuid appointment_id FK
        uuid equipment_id FK
        int quantity "INT"
    }
    CHECKINS {
        uuid id PK
        uuid organization_id FK
        uuid appointment_participant_id FK
        timestamptz checked_in_at "PES"
        string method "PES"
        uuid recorded_by_membership_id FK
    }
    WAITLIST_ENTRIES {
        uuid id PK
        uuid organization_id FK
        uuid appointment_id FK
        uuid client_id FK
        string status "PES"
        timestamptz queued_at "PES"
    }
    WAITLIST_OFFERS {
        uuid id PK
        uuid organization_id FK
        uuid waitlist_entry_id FK
        string status "PES"
        timestamptz offered_at "PES"
        timestamptz expires_at "PES"
        timestamptz consumed_at "PES"
        uuid consumed_by_participant_id FK
    }
    REPLACEMENT_CREDITS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        uuid source_participant_id FK
        uuid consumed_by_participant_id FK
        string status "PES"
        date expires_on "PES"
        timestamptz consumed_at "PES"
    }
```

Restrições transacionais:

- Participante único por `(organization_id, appointment_id, client_id)` enquanto ativo; capacidade é ocupada e validada na mesma transação.
- Exclusões de intervalo impedem sobreposição do profissional e da sala. Reserva de equipamento valida quantidade disponível no intervalo.
- Uma série guarda a regra e cada ocorrência é um `appointment`; alterações pontuais não reescrevem a série inteira.
- Há no máximo uma entrada ativa por cliente/agendamento, uma oferta ativa por vaga e consumo atômico antes de `expires_at`.
- Crédito possui exatamente uma origem e, quando consumido, exatamente um participante de destino. Saldo não é um campo mutável: deriva de créditos válidos ainda não consumidos.
- Cancelamento, presença e falta são estados históricos/auditados; não removem o participante.

## 6. Financeiro, fiscal e contratos

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ PLANS : oferece
    CLIENTS ||--o{ CONTRACTS : contrata
    PLANS ||--o{ CONTRACTS : rege
    CONTRACTS o|--o{ RECEIVABLES : gera
    CLIENTS ||--o{ RECEIVABLES : deve
    FINANCIAL_CATEGORIES ||--o{ RECEIVABLES : classifica
    FINANCIAL_CATEGORIES ||--o{ PAYABLES : classifica
    RECEIVABLES ||--o{ PAYMENTS : recebe
    RECEIVABLES ||--o{ FISCAL_DOCUMENTS : documenta
    FISCAL_DOCUMENTS ||--o{ FISCAL_ATTEMPTS : tenta_emitir
    FISCAL_DOCUMENTS ||--o{ FISCAL_EVENTS : historico

    PLANS {
        uuid id PK
        uuid organization_id FK
        string name "INT"
        int price_cents "PES"
        string currency "INT"
        string billing_rule "INT"
        boolean active "INT"
    }
    CONTRACTS {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        uuid plan_id FK
        date starts_on "PES"
        date ends_on "PES"
        int agreed_price_cents "PES"
        string status "PES"
    }
    FINANCIAL_CATEGORIES {
        uuid id PK
        uuid organization_id FK
        string kind "INT"
        string name "INT"
        boolean active "INT"
    }
    RECEIVABLES {
        uuid id PK
        uuid organization_id FK
        uuid client_id FK
        uuid contract_id FK
        uuid category_id FK
        int original_amount_cents "PES"
        string currency "INT"
        date due_on "PES"
        string status "PES"
        string idempotency_key "SEG"
    }
    PAYABLES {
        uuid id PK
        uuid organization_id FK
        uuid category_id FK
        string counterparty "PES"
        string description "PES"
        int amount_cents "PES"
        string currency "INT"
        date due_on "PES"
        string status "PES"
    }
    PAYMENTS {
        uuid id PK
        uuid organization_id FK
        uuid receivable_id FK
        uuid reverses_payment_id FK
        int amount_cents "PES"
        string method "PES"
        string external_reference "SEG"
        timestamptz paid_at "PES"
    }
    FISCAL_DOCUMENTS {
        uuid id PK
        uuid organization_id FK
        uuid receivable_id FK
        string status "PES"
        string provider "INT"
        string provider_document_id "SEG"
        string idempotency_key "SEG"
        int amount_cents "PES"
    }
    FISCAL_ATTEMPTS {
        uuid id PK
        uuid organization_id FK
        uuid fiscal_document_id FK
        int attempt_number "INT"
        string request_digest "SEG"
        string response_code "INT"
        timestamptz attempted_at "INT"
    }
    FISCAL_EVENTS {
        uuid id PK
        uuid organization_id FK
        uuid fiscal_document_id FK
        string event_type "INT"
        string provider_event_id "SEG"
        jsonb sanitized_payload "PES"
        timestamptz occurred_at "INT"
    }
```

Regras principais:

- O saldo de um recebível deriva do valor original menos pagamentos líquidos e estornos. Pagamento parcial não sobrescreve o valor original.
- Estorno é um novo `payment` com `reverses_payment_id`; lançamentos liquidados são imutáveis.
- A unicidade de `idempotency_key` é por organização e operação. Uma cobrança não pode ter duas NFS-e autorizadas equivalentes.
- Estados e políticas de cobrança estão formalizados em `FIN-001`; o modelo preserva valor original, parciais, estornos e histórico.
- Dados tributários completos, XML e PDF são `PES`/`SEN` conforme o conteúdo e ficam em arquivo privado. Credenciais e certificados fiscais são segredos de infraestrutura, não colunas destas tabelas.

## 7. Plataforma, arquivos, notificações e auditoria

```mermaid
erDiagram
    ORGANIZATIONS ||--o{ FILES : possui
    FILES ||--o{ FILE_LINKS : anexa
    USERS ||--o{ NOTIFICATION_PREFERENCES : configura
    ORGANIZATIONS ||--o{ NOTIFICATION_PREFERENCES : delimita
    USERS ||--o{ NOTIFICATIONS : recebe
    ORGANIZATIONS ||--o{ NOTIFICATIONS : envia
    ORGANIZATIONS ||--o{ OUTBOX_EVENTS : produz
    OUTBOX_EVENTS o|--o{ NOTIFICATIONS : dispara
    NOTIFICATIONS ||--o{ PUSH_DELIVERIES : materializa
    PUSH_DEVICES ||--o{ PUSH_DELIVERIES : recebe
    ORGANIZATIONS ||--o{ AUDIT_EVENTS : registra
    MEMBERSHIPS o|--o{ AUDIT_EVENTS : atua

    FILES {
        uuid id PK
        uuid organization_id FK
        string storage_key "SEG"
        string media_type "INT"
        bigint size_bytes "INT"
        string checksum "SEG"
        string classification "INT"
        string scan_status "INT"
        uuid uploaded_by_membership_id FK
    }
    FILE_LINKS {
        uuid id PK
        uuid organization_id FK
        uuid file_id FK
        string target_type "INT"
        uuid target_id "INT"
        string purpose "INT"
    }
    NOTIFICATION_PREFERENCES {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        string channel "INT"
        string event_type "INT"
        boolean enabled "PES"
    }
    NOTIFICATIONS {
        uuid id PK
        uuid organization_id FK
        uuid user_id FK
        uuid outbox_event_id FK
        string channel "INT"
        string safe_template_key "INT"
        string status "INT"
        timestamptz delivered_at "INT"
    }
    PUSH_DELIVERIES {
        uuid id PK
        uuid organization_id FK
        uuid notification_id FK
        uuid push_device_id FK
        string status "INT"
        int attempt_count "INT"
        timestamptz available_at "INT"
        string provider_message_id "SEG"
        string last_error_code "INT"
    }
    OUTBOX_EVENTS {
        uuid id PK
        uuid organization_id FK
        string aggregate_type "INT"
        uuid aggregate_id "INT"
        string event_type "INT"
        jsonb safe_payload "PES"
        timestamptz available_at "INT"
        timestamptz processed_at "INT"
        int attempt_count "INT"
        timestamptz locked_at "INT"
        string locked_by "SEG"
        string last_error_code "INT"
        timestamptz failed_at "INT"
    }
    AUDIT_EVENTS {
        uuid id PK
        uuid organization_id FK
        uuid actor_membership_id FK
        string action "INT"
        string target_type "INT"
        uuid target_id "INT"
        jsonb minimal_metadata "PES"
        timestamptz occurred_at "INT"
    }
```

Decisões de integridade e exposição:

- `file_links.target_type` é uma associação controlada. Em `DATA-002`, cada tipo permitido deve ganhar FK verificável (tabela de vínculo específica ou trigger); não será aceito um alvo arbitrário sem integridade.
- `storage_key` nunca é URL pública. Download revalida tenant, função, relação com o atendimento e, para conteúdo clínico, permissão clínica.
- `safe_template_key` impede que o push de tela bloqueada carregue nome, condição clínica, valor ou conteúdo fiscal. O detalhe só é obtido depois da autenticação.
- `outbox_events` nasce na mesma transação da mudança de domínio. Processamento é idempotente e preserva tentativas fora do payload de negócio.
- Auditoria registra somente metadados mínimos; não copia prontuário, documento, token, corpo fiscal ou valores anteriores completos. Eventos são append-only e com retenção protegida.

## 8. Restrições que o esquema físico deve provar

`DATA-002` estabelece as constraints e os testes estruturais disponíveis sem identidade autenticada. Regras que dependem do ator, de concorrência distribuída ou de uma política de negócio ainda pendente devem ser ampliadas na tarefa indicada, sem remover a proteção já existente no banco:

1. uma FK não aceita registros de outra organização, mesmo com UUID conhecido;
2. RLS nega leitura e escrita cruzadas e nega por padrão quando não há contexto de tenant (`DATA-002`, ampliado em `AUTH-004`);
3. membership revogada não autoriza novas operações (`AUTH-002`/`AUTH-004`);
4. participante duplicado e overbooking concorrente falham de forma determinística (`DATA-002`, ampliado em `QA-002`);
5. sobreposição inválida de profissional, sala e equipamento é rejeitada (`DATA-002`, ampliado em `QA-002`);
6. oferta de fila expirada ou já consumida não cria participante (`WAIT-002`/`WAIT-003`);
7. crédito de reposição não pode ser consumido duas vezes (`REP-001`/`REP-002`);
8. pagamentos parciais e estornos reconciliam sem apagar histórico (`DATA-002`, ampliado em `QA-003`);
9. idempotência impede duplicação de recebível, evento Outbox e documento fiscal equivalente (`DATA-002`, ampliado nas tarefas funcionais correspondentes);
10. exclusão lógica não rompe auditoria, financeiro, prontuário ou histórico fiscal;
11. nenhum seed contém nome, contato, documento ou informação clínica de pessoa real.

## 9. Pontos deliberadamente pendentes

- Campos clínicos, assinaturas e anexos: `NEG-004`.
- Políticas de cancelamento, falta e validade de reposição: `NEG-002`.
- Duração/configuração das ofertas de fila: `NEG-003` (10 minutos permanece o padrão inicial aprovado).
- Juros, multa, desconto, vencimento e regras de estorno: `FIN-001`.
- Bases legais e prazos de retenção: `NEG-008` e `LGPD-001`.

Essas pendências alteram atributos e políticas, mas não alteram a raiz multiempresa, a separação entre identidade e cadastro operacional, nem a exigência de histórico imutável para operações críticas.
