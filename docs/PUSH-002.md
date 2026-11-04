# PUSH-002 — Entrega de push por evento Outbox

## Resultado

O evento idempotente `waitlist.offer.created`, gravado na mesma transação da oferta, gera no máximo uma notificação por usuário e uma entrega por dispositivo. Um worker com lease envia pelo FCM, repete falhas transitórias e não recria nem altera a oferta.

## Fluxo e idempotência

1. O worker reivindica eventos disponíveis com `FOR UPDATE SKIP LOCKED` e lease de dois minutos.
2. O destinatário é derivado no servidor pela relação oferta → entrada da fila → cliente → usuário; o payload do evento não escolhe o destinatário.
3. Antes de materializar a notificação, o servidor revalida que a oferta continua ativa e não expirou e que a preferência está habilitada.
4. As restrições únicas `(evento, usuário, canal)` e `(notificação, dispositivo)` tornam o reprocessamento idempotente.
5. Entregas já enviadas não são selecionadas novamente. Token inválido é cancelado e revogado.
6. Falhas transitórias usam atraso exponencial, limitado a cinco minutos, com até cinco tentativas. Depois disso, o evento e a entrega ficam em estado terminal para inspeção.

O processamento é no mínimo uma vez entre o FCM e o banco: uma queda exatamente após a aceitação remota pode repetir a mensagem, pois a API HTTP v1 não oferece chave idempotente. Isso não duplica a oferta, a notificação persistida nem qualquer efeito de domínio.

## Persistência operacional

- `outbox_events` registra tentativas, lease, próximo instante, último código de erro, conclusão ou falha terminal.
- `notifications` registra a mensagem lógica sem conteúdo sensível.
- `push_deliveries` registra cada dispositivo, tentativas, entrega, erro e identificador retornado pelo provedor.
- Nenhum erro persistido ou logado inclui token ou resposta textual potencialmente sensível do FCM.
- A migration `021_push_outbox_delivery` aplica RLS à nova tabela e possui rollback completo.

## Operação

O worker executa no processo da API a cada cinco segundos por padrão; `PUSH_WORKER_INTERVAL_MS` altera o intervalo. Instâncias concorrentes são seguras pelo lease e pelas restrições de unicidade.

## Evidências

Testes unitários cobrem sucesso, retentativa e revogação por token inválido. O teste de esquema cobre materialização repetida sem duplicidade, entrega persistida, conclusão do evento, RLS e rollback das migrations.
