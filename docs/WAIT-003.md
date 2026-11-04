# WAIT-003 — Confirmação da vaga oferecida

## Resultado

O cliente confirma a oferta ativa na própria área e recebe uma participação confirmada na turma. A oferta, a entrada da fila, a participação e o eventual crédito de reposição mudam de estado na mesma transação; repetir a confirmação devolve a mesma participação.

## Contrato HTTP

| Método | Rota | Permissão | Resultado |
| --- | --- | --- | --- |
| `POST` | `/api/organizations/:organizationId/client-area/appointments/:appointmentId/waitlist/confirm` | `schedule.own.manage` | Consome a oferta do titular e devolve o agendamento próprio confirmado. |

A identidade do cliente deriva de `clients.user_id`. A rota não aceita `clientId`, `offerId` nem identificador de crédito informado pelo navegador.

## Cobertura e consistência

- A turma é bloqueada antes de revalidar a oferta, a capacidade e criar a participação.
- A oferta precisa estar ativa, pertencer ao titular e ainda estar dentro de `expires_at`; uma oferta vencida é expirada e a fila avança antes da resposta.
- Um contrato ativo com plano ativo deve cobrir a data local da turma. Sem contrato elegível, o crédito disponível que vence primeiro é consumido, desde que continue válido na data da turma.
- A criação da participação reaplica as proteções de cliente ativo, capacidade e conflito de horário do PostgreSQL.
- `waitlist_offers.consumed_by_participant_id` liga o consumo à participação e uma trigger impede consumo vencido, sem participação ativa correspondente ou com cliente/turma divergentes.
- Confirmações repetidas são idempotentes e não duplicam participação, auditoria, Outbox ou consumo de crédito.
- O consumo gera `waitlist.offer_consumed` na auditoria e `waitlist.offer.consumed` na Outbox, ambos sem dados pessoais.

## Interface

Ofertas ativas exibem **Confirmar vaga** e **Sair da fila**. Após a confirmação, a turma sai da fila, entra em Meus agendamentos e uma mensagem de sucesso é anunciada.

## Evidências

Os testes cobrem o contrato HTTP, autorização própria, interface, rollback quando falta cobertura, uso de plano, consumo de um único crédito, revalidação de capacidade e conflito, vínculo oferta–participação, repetição idempotente e efeitos únicos de auditoria/Outbox. A migration `022_waitlist_offer_confirmation` possui rollback completo.

