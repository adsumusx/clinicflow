# WAIT-002 — Oferta temporária de vaga

## Resultado

Quando uma participação de turma é cancelada, a vaga é oferecida à primeira pessoa da fila por um período configurável. Existe no máximo uma oferta ativa por turma; ao expirar ou ser recusada, a próxima pessoa é selecionada atomicamente.

## Contrato e processamento

| Método | Rota | Permissão | Resultado |
| --- | --- | --- | --- |
| `POST` | `/api/organizations/:organizationId/appointments/:appointmentId/waitlist/advance` | `schedule.manage` | Expira a oferta vencida e cria a próxima quando ainda há vaga. |

O avanço também ocorre na mesma transação que cancela uma participação e, de forma oportunista, nas consultas da fila e da agenda. Um agendador pode chamar a rota de avanço no instante de vencimento sem alterar a semântica idempotente.

## Consistência e estados

- `organizations.waitlist_offer_minutes` configura a validade entre 1 minuto e 24 horas; o padrão é 15 minutos.
- A turma é bloqueada com `FOR UPDATE` antes de expirar, selecionar ou criar oferta.
- O índice parcial `waitlist_offers_one_active_per_appointment` impede duas ofertas ativas para a mesma turma, mesmo em chamadas concorrentes.
- A seleção usa `queue_position`; oferta expirada marca a entrada como `expired` e avança para a próxima entrada `queued`.
- Reprocessar enquanto há oferta válida devolve a oferta existente e não duplica auditoria nem Outbox.
- Enquanto há oferta válida, a inclusão administrativa de outro participante é recusada para preservar a vaga reservada.
- Cancelar a turma encerra ofertas e interesses ativos. Turma iniciada também não gera novas ofertas.
- Criação e expiração produzem eventos idempotentes `waitlist.offer.created` e `waitlist.offer.expired`, sem dados pessoais.

## Limite desta entrega

A confirmação e o consumo atômico da oferta pertencem a `WAIT-003`. Nesta entrega, a interface informa a validade e permite sair da fila, mas não converte a oferta em participação.

## Evidências

Os testes PostgreSQL cobrem oferta ao primeiro colocado, bloqueio de desvio da vaga, expiração, avanço ordenado, reprocessamento idempotente e uma única oferta ativa. A migration `020_waitlist_interest_offers` possui rollback completo.
