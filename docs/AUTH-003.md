# AUTH-003 — RBAC granular

> Estado: **Concluída**. Revisão: 2026-09-01.

## Resultado

A autorização deixou de depender de nomes fixos de papel. Cada função recebe capacidades por `role_permissions`, a sessão expõe somente os códigos concedidos e toda operação protegida exige explicitamente a capacidade correspondente. A ausência da capacidade resulta em `403 PERMISSION_DENIED`.

A migration `007_auth_rbac` mantém um catálogo global de permissões e uma matriz inicial inspecionável em `role_permission_defaults`. Novas organizações recebem essa matriz ao criar seus cinco papéis iniciais.

## Matriz inicial

| Área | Proprietário | Admin | Profissional | Recepção/Financeiro | Cliente |
| --- | --- | --- | --- | --- | --- |
| Organização | Ler/gerenciar | Ler/gerenciar | — | — | — |
| Memberships | Ler/gerenciar/privilegiadas | Ler/gerenciar não privilegiadas | — | — | — |
| Agenda | Total | Total | Conforme vínculo | Operacional | Somente própria |
| Clientes | Total | Total | Leitura conforme atendimento | Operacional | Somente próprio |
| Clínico | Total | Bloqueado por padrão | Ler/escrever conforme atendimento | Bloqueado | Publicado e próprio |
| Financeiro/fiscal | Total | Total | — | Total | Somente próprio liberado |
| Recursos | Total | Total | Leitura | Leitura | — |
| Auditoria | Ler | Ler | — | — | — |

Permissão de área não substitui escopo de registro. Os fluxos futuros ainda devem validar vínculo profissional-cliente e propriedade do cliente para capacidades como `clients.read`, `clinical.read` e os códigos `*.own.*`.

## Controles aplicados

- `memberships.read` protege a listagem da equipe;
- `memberships.manage` protege convite e revogação;
- `roles.manage_privileged` é adicionalmente obrigatória para atribuir ou revogar `owner`, `admin` ou outra função marcada como privilegiada;
- a organização da rota deve ser exatamente a organização selecionada na sessão;
- o repositório repete as verificações sensíveis dentro da transação, reduzindo risco de TOCTOU;
- a interface usa as capacidades apenas para apresentação; a API continua sendo a autoridade.

## Verificação

Os testes cobrem negação por padrão, organização diferente da selecionada, elevação para papel privilegiado e a matriz persistida. O esquema também comprova que `admin` não recebe acesso clínico por padrão e que cliente não recebe permissões financeiras administrativas.
