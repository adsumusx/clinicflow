# AUTH-001 — Cadastro, login, recuperação e sessão

> Estado: **Concluída**. Revisão: 2026-09-01.

## Resultado

O ClinicFlow possui uma API HTTP própria e uma interface responsiva para cadastro, login, solicitação de recuperação, redefinição de senha e logout. O navegador recebe somente uma sessão opaca em cookie `HttpOnly`; tokens não são gravados em `localStorage`.

## Controles implementados

- senhas entre 12 e 128 caracteres, derivadas com `scrypt` e salt aleatório;
- sessão aleatória de 256 bits, persistida no banco apenas como SHA-256;
- cookie `HttpOnly`, `SameSite=Lax`, `Path=/` e `Secure` em produção;
- sessão expira em 8 horas e logout a revoga no servidor;
- recuperação expira em 30 minutos, é de uso único e revoga todas as sessões ao trocar a senha;
- login usa o mesmo trabalho criptográfico e a mesma resposta para conta inexistente ou senha incorreta;
- recuperação sempre retorna a mesma confirmação, exista ou não a conta;
- limitação de tentativas por endereço e rota nos endpoints públicos;
- respostas e logs não incluem senha, token, e-mail ou detalhes internos.

As tabelas `user_credentials` e `password_reset_tokens` são dados globais de identidade e, assim como `sessions`, não podem ser consultadas pelo papel `clinicflow_app`. A API de identidade usa a conexão administrativa dedicada e consultas fechadas; futuras rotas de negócio deverão continuar usando `APP_DATABASE_URL` com o tenant definido na transação.

## Entrega da recuperação

Em produção, configure `PASSWORD_RESET_WEBHOOK_URL` para um serviço transacional que aceite:

```json
{
  "to": "pessoa@example.com",
  "resetUrl": "https://app.example.com/#reset-password?token=..."
}
```

`PASSWORD_RESET_BASE_URL` define a origem do link. Sem webhook, o ambiente local mantém a resposta genérica e registra apenas que o notificador não foi configurado — nunca imprime o destinatário ou token. O adaptador é exercitado diretamente pelos testes automatizados.

## Conta local sintética

Após `npm run db:reset`, o fluxo pode ser validado sem dados reais:

- e-mail: `proprietario.a@example.invalid`
- senha: `ClinicaDemo!2026`

Essas credenciais são exclusivamente locais e não podem ser reutilizadas.

## Verificação

Os testes cobrem cadastro e hashing, equivalência das falhas de login, resposta não enumerável da recuperação, redefinição e revogação. A migration é aplicada e revertida junto com toda a suíte do esquema.
