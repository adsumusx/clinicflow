# WAIT-001 — Fila de interesse

## Resultado

O cliente visualiza turmas futuras lotadas, registra interesse e acompanha ou cancela a própria posição. A equipe vê a fila ativa junto da agenda operacional.

## Contrato HTTP

| Método | Rota | Permissão | Resultado |
| --- | --- | --- | --- |
| `GET` | `/api/organizations/:organizationId/client-area/waitlist` | `schedule.own.read` | Lista interesses próprios e turmas lotadas elegíveis. |
| `POST` | `/api/organizations/:organizationId/client-area/appointments/:appointmentId/interest` | `schedule.own.manage` | Registra o titular no fim da fila. |
| `DELETE` | `/api/organizations/:organizationId/client-area/appointments/:appointmentId/interest` | `schedule.own.manage` | Cancela o interesse ativo do titular. |

## Consistência e segurança

- A identidade do cliente sempre deriva de `clients.user_id`; a API não aceita `clientId` informado pelo navegador.
- Somente turma futura, ativa e lotada aceita interesse. Participantes ativos não podem entrar na fila.
- A linha da turma é bloqueada antes de validar ocupação e calcular `queue_position`. Assim, inclusões concorrentes recebem posições monotônicas e distintas.
- O índice parcial existente mantém no máximo um interesse `queued` ou `offered` por cliente e turma; repetir o `POST` devolve a mesma entrada.
- RLS, membership ativa, capacidades próprias, auditoria e Outbox são aplicados às mutações. Payloads não carregam nome, contato ou informação clínica.

## Evidências

A migration reversível `020_waitlist_interest_offers` formaliza posição positiva e única por turma. Testes de serviço, HTTP, interface e PostgreSQL cobrem escopo próprio, idempotência, unicidade e ordem.
