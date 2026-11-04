# AUTH-005 — MFA para contas privilegiadas

> Estado: **Concluída**. Revisão: 2026-09-01.

## Resultado

Toda conta com membership ativa em uma função marcada como `privileged` precisa concluir um segundo fator antes de receber uma sessão utilizável. Os papéis iniciais `owner` e `admin` são privilegiados.

O fator implementado é TOTP compatível com aplicativos autenticadores. Novos proprietários e contas privilegiadas antigas sem fator entram no cadastro obrigatório depois da senha; contas já configuradas recebem um desafio a cada novo login. Não há opção de ignorar ou lembrar dispositivo nesta etapa.

## Fluxo

1. A senha é validada sem criar cookie de sessão.
2. O backend verifica se existe qualquer membership privilegiada ativa.
3. Sem fator cadastrado, a API cria um segredo TOTP individual e um desafio de matrícula.
4. Com fator cadastrado, a API cria somente um desafio de autenticação.
5. Um TOTP válido ou código de recuperação de uso único consome o desafio.
6. Somente então uma nova sessão opaca é criada com `mfa_verified_at`.

Sessões antigas sem essa evidência deixam de funcionar assim que a conta possui uma função privilegiada ativa. Elevar a função, portanto, não reaproveita uma sessão autenticada apenas por senha.

## Controles

- TOTP SHA-1 de seis dígitos e intervalo de 30 segundos, conforme RFC 6238;
- tolerância máxima de um intervalo adjacente;
- `last_used_step` impede aceitar o mesmo TOTP duas vezes;
- desafio opaco de 256 bits, validade de cinco minutos e máximo de cinco erros;
- bloqueio por conta após dez erros acumulados em quinze minutos, mesmo criando novos desafios;
- rate limit adicional no endpoint HTTP;
- segredo TOTP cifrado com AES-256-GCM e chave externa ao banco;
- dez códigos de recuperação aleatórios, armazenados somente como SHA-256 e consumidos uma vez;
- fatores, desafios e recuperação inacessíveis ao papel `clinicflow_app`;
- redefinir a senha revoga sessões, mas não remove o segundo fator.

TOTP reduz o risco de comprometimento por senha, mas não é resistente a phishing. Uma evolução futura pode adicionar WebAuthn/passkeys sem enfraquecer a obrigatoriedade atual.

## Configuração

`MFA_ENCRYPTION_KEY` é obrigatória na API e deve conter 32 bytes codificados em base64url. Em produção, gere uma chave exclusiva e armazene-a no gerenciador de segredos:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

A chave local de `.env.example` é somente para desenvolvimento e nunca deve ser reutilizada em outro ambiente.

## API

| Método e rota | Resultado |
| --- | --- |
| `POST /api/auth/register` | Retorna `mfa_required` para o novo proprietário, sem cookie. |
| `POST /api/auth/login` | Retorna sessão para conta comum ou `mfa_required` para conta privilegiada. |
| `POST /api/auth/mfa/verify` | Consome TOTP/recuperação e cria a sessão; na matrícula exibe recuperação uma vez. |

## Verificação

Os testes cobrem o vetor oficial do RFC 6238, janela temporal, cifragem autenticada, cadastro obrigatório, ausência de sessão após apenas a senha, limite de tentativas, replay, recuperação de uso único, isolamento das tabelas de identidade e rollback da migration.

Referências: [RFC 6238](https://www.rfc-editor.org/info/rfc6238/), [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html) e [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).
