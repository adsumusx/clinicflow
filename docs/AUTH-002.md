# AUTH-002 — Organizações e memberships

> Estado: **Concluída**. Revisão: 2026-09-01.

## Resultado

Cada cadastro cria uma organização e uma membership de proprietário. Uma conta pode participar de várias organizações, alterná-las pelo shell e criar outra organização. A tela **Mais → Organização e equipe** permite que proprietário ou administrador consulte vínculos, registre convites e revogue acessos.

## Regra de isolamento

O identificador enviado pelo navegador nunca concede acesso. Para selecionar ou operar uma organização, a API exige simultaneamente:

1. sessão ativa e não expirada;
2. usuário ativo;
3. organização ativa;
4. membership ativa do usuário naquela organização.

A organização selecionada só é gravada na sessão após essa consulta. Revogar uma membership também remove aquela organização das sessões da pessoa. As políticas RLS de `DATA-002` continuam sendo a barreira adicional para as futuras consultas de negócio.

## Ciclo dos vínculos

- o convite cria uma identidade `pending` quando o e-mail ainda não existe;
- ao cadastrar a conta, os convites pendentes tornam-se ativos;
- somente `owner` e `admin` gerenciam vínculos nesta etapa;
- ninguém revoga o próprio vínculo por esse fluxo;
- a última membership de proprietário não pode ser revogada;
- vínculos revogados ficam no histórico e deixam de autorizar imediatamente.

A matriz granular de permissões foi implementada posteriormente em [`AUTH-003`](./AUTH-003.md); as regras mínimas desta etapa foram substituídas por capacidades negadas por padrão.

## API

| Método e rota | Finalidade |
| --- | --- |
| `GET /api/auth/session` | Retorna usuário, organização selecionada e organizações permitidas. |
| `POST /api/organizations` | Cria organização com membership de proprietário. |
| `POST /api/organizations/select` | Seleciona somente organização com membership ativa. |
| `GET /api/organizations/:id/memberships` | Lista vínculos para gestores. |
| `POST /api/organizations/:id/memberships` | Registra convite com função existente no tenant. |
| `DELETE /api/organizations/:id/memberships/:membershipId` | Revoga o vínculo sem apagá-lo. |

## Verificação

Além dos testes unitários, a API foi exercitada no PostgreSQL 17 local: login sintético retornou `200`, leitura da sessão retornou `200`, tentativa de selecionar a organização Beta sem membership retornou `403` e logout retornou `204`.
