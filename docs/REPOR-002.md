# REPOR-002 — Relatório de aniversariantes

## Resultado

O relatório lista aniversários que ocorrem no período selecionado, inclusive quando o período cruza a virada do ano. Cada ocorrência apresenta data, cliente e situação. Aniversários em 29 de fevereiro aparecem somente quando a data existe no período consultado.

## Preferência de contato

O cliente aparece no relatório mesmo sem autorização de contato, para que a informação cadastral continue correta. Telefone, e-mail ou outro contato só é retornado quando as duas condições são verdadeiras:

1. existe consentimento ativo com `purpose = 'birthday_contact'`, `granted_at` preenchido e sem `revoked_at`;
2. existe contato marcado como preferencial.

Sem ambas as condições, a API retorna `contactAllowed: false` e `preferredContact: null`. Essa supressão ocorre na consulta ao banco e é preservada no CSV. Quando há mais de um tipo preferencial, telefone tem precedência sobre e-mail e outros tipos.

## Filtros

- `from` e `to` selecionam a ocorrência anual do aniversário, não o ano de nascimento.
- `status` inclui clientes ativos ou inativos; arquivados e excluídos logicamente nunca aparecem.
- `unitId` e `professionalId` atribuem o cliente por uma participação vigente (`booked`, `confirmed` ou `attended`) em agendamento não cancelado.

## Evidências

Os testes verificam listagem, ausência de vazamento após revogação do consentimento, negação para perfil sem `reports.read`, filtros combinados, estados da interface e exportação sem divergência da tela.

