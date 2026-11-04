# LEAD-002 — Conversão de prospecção em cliente

## Resultado

Uma prospecção pode ser convertida em cliente diretamente no funil. Nome e contatos são copiados para o cadastro; o operador escolhe o tipo fixo/rotativo e pode completar nascimento e documento. A prospecção não é apagada: passa à etapa `converted`, recebe `converted_client_id` e `converted_at`, e mantém todas as interações.

## Contrato e idempotência

`POST /api/organizations/:organizationId/prospects/:prospectId/convert` exige simultaneamente `prospects.manage` e `clients.manage`.

O corpo aceita:

- `clientType`: `fixed` ou `rotating`, com padrão seguro `rotating`;
- `birthDate`: data opcional válida;
- `documentNumber`: documento opcional normalizado.

A primeira execução retorna `201` e `{ created: true, prospect, client }`. Repetições retornam `200` e `{ created: false, prospect, client }`, sempre apontando para o mesmo cliente originalmente criado, mesmo que o segundo corpo seja diferente.

## Consistência e segurança

A operação bloqueia a linha da prospecção com `FOR UPDATE`. Criação do cliente, cópia dos contatos, vínculo, etapa, interação de conversão e auditoria ocorrem em uma única transação. O índice único `(organization_id, converted_client_id)` e a restrição de consistência entre etapa, vínculo e instante reforçam a regra no banco.

Duplicidade de documento ou contato com um cliente existente cancela toda a transação e retorna `409 CLIENT_DUPLICATE`. Uma prospecção ausente ou de outra clínica usa a resposta genérica `404 PROSPECT_NOT_FOUND`; permissão e RLS continuam sendo verificadas no servidor e no banco.

Os eventos `client.created` e `prospect.converted` não contêm nome ou valores de contato. O histórico operacional permanece consultável na prospecção convertida.

## Evidências

Testes exercitam conversão, repetição idempotente com corpo divergente, bloqueio transacional, preservação da prospecção e interações, rollback por duplicidade de clientes, capacidades combinadas, isolamento, auditoria sem dados pessoais, status HTTP e fluxo da interface. Execute `npm run check` para a verificação completa.
