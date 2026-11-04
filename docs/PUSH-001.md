# PUSH-001 — FCM e preferências

## Resultado

Uma sessão autenticada pode registrar, listar e revogar os próprios dispositivos FCM. Cada usuário também controla a preferência de push por clínica. Tokens nunca aparecem nas respostas, logs ou tabelas em claro.

## Contratos

| Método | Rota | Resultado |
| --- | --- | --- |
| `GET` | `/api/push/devices` | Lista somente identificador, plataforma, estado e datas dos dispositivos do usuário. |
| `POST` | `/api/push/devices` | Registra ou reativa `{ "platform": "web|android", "token": "..." }`. |
| `DELETE` | `/api/push/devices/:deviceId` | Revoga um dispositivo pertencente à sessão. |
| `GET` | `/api/organizations/:organizationId/notification-preferences` | Lista preferências efetivas; a ausência de configuração equivale a habilitada. |
| `PUT` | `/api/organizations/:organizationId/notification-preferences` | Atualiza `{ "eventType": "waitlist.offer.created", "enabled": false }`. |

As mutações exigem mesma origem. Preferências são limitadas à organização selecionada e a uma membership ativa.

## Proteção do token e da mensagem

- O token é cifrado com AES-256-GCM e nonce novo a cada gravação.
- Uma impressão SHA-256 permite deduplicar o mesmo token sem expô-lo.
- `PUSH_TOKEN_ENCRYPTION_KEY` deve ter 32 bytes em base64url e ser distinta das demais chaves em produção.
- A mensagem usa template fixo. Não contém paciente, serviço, profissional, horário, valor, identificador da oferta ou payload da Outbox.
- O detalhe é consultado na área autenticada; o push leva apenas a rota genérica `/area-do-cliente`.
- Um token rejeitado definitivamente pelo FCM é revogado automaticamente.

## Configuração FCM

O servidor usa a API HTTP v1. Configure em conjunto `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL` e `FIREBASE_PRIVATE_KEY`. Se as três forem omitidas, a API de dispositivos permanece disponível e o worker não inicia; eventos continuam pendentes para processamento posterior.

O cliente web ou Android obtém o token com o SDK oficial do Firebase e o registra pela API. A integração do ciclo nativo, abertura de rota e revogação no logout do aplicativo pertence a `AND-002`.

## Evidências

Testes cobrem cifragem não determinística, impressão estável, validação e propriedade na revogação, preferência por organização, proteção de origem e ausência de dados sensíveis no template.
