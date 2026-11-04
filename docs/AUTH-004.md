# AUTH-004 — RLS e isolamento entre clínicas

> Estado: **Concluída**. Revisão: 2026-09-01.

## Resultado

As policies RLS agora exigem a combinação de dois valores definidos no contexto da transação: `app.user_id` e `app.organization_id`. A linha só fica visível ou gravável quando o usuário está ativo, a organização está ativa e existe uma membership ativa entre ambos.

Isso fecha a lacuna anterior em que conhecer ou configurar outro `organization_id` seria suficiente para trocar o filtro da RLS. Sem usuário, sem organização, com membership ausente/revogada ou com o par usuário-organização divergente, a regra nega por padrão.

## Barreiras complementares

1. A API obtém o usuário da sessão opaca e só opera sobre a organização selecionada nela.
2. O RBAC exige a permissão da ação antes de chamar o repositório.
3. As consultas de negócio devem usar o papel `clinicflow_app`, que é `NOSUPERUSER` e `NOBYPASSRLS`, definindo ambos os contextos localmente na transação.
4. FKs compostas continuam impedindo que uma linha de uma clínica referencie outra.
5. Identidade, credenciais e sessões permanecem fora do papel de negócio e são acessadas apenas pelo repositório fechado de autenticação.

## Uso obrigatório em repositórios de negócio

Cada transação deve configurar os dois valores como locais antes da primeira consulta:

```sql
SELECT set_config('app.user_id', $1, true);
SELECT set_config('app.organization_id', $2, true);
```

Os valores devem vir do contexto autenticado produzido pelo backend, nunca diretamente do corpo, query string ou parâmetro de rota.

## Verificação

Os testes executam com `SET ROLE clinicflow_app` e comprovam:

- leitura normal da Clínica Alfa pelo proprietário Alfa;
- zero linhas ao combinar o mesmo usuário com a Clínica Beta;
- leitura da Beta somente após trocar também para seu proprietário;
- zero linhas sem um dos contextos;
- falha de escrita com `organization_id` cruzado;
- corte imediato de acesso após revogação da membership;
- `403` no backend quando a rota aponta para organização diferente da selecionada.
