# AUTH-006 — Convites por Companhia, QR Code e Cadastro Exclusivo

> Estado: **Concluída**. Revisão: 2026-10-26.

## Resultado

O ClinicFlow agora adota um fluxo de cadastro estritamente baseado em convites emitidos por uma companhia/organização existente:

1. **Cadastro de companhias direto no banco de dados**:
   - A criação de novas organizações não fica aberta publicamente no fluxo de cadastro.
   - O provisionamento inicial ou de novas clínicas é feito diretamente no banco (ex.: migrations/seeds/SQL administrativo).
2. **Convite por link e QR Code**:
   - Administradores e gestores da clínica (com permissão `memberships.manage`) geram convites vinculados à organização e à função desejada (Profissional, Recepção/Financeiro, Cliente, Administrador).
   - O convite produz um token opaco e um link exclusivo de cadastro (`/#register?invite=<token>`).
   - A interface gera e exibe um **QR Code** vetorial de alta definição para o link, permitindo leitura direta pela câmera do celular ou compartilhamento/cópia do link.
   - Na listagem de equipe, vínculos com status de convite pendente permitem reabrir o QR Code e o link a qualquer momento.
3. **Criação de conta pelo convidado**:
   - Acessar `/#register` diretamente sem token de convite exibe aviso informativo de que o sistema é exclusivo para pessoas convidadas.
   - Acessar o link ou QR Code (`?invite=<token>`) valida o convite no backend, exibindo a clínica e a função correspondente.
   - O convidado define sua senha (mínimo 12 caracteres) e conclui o cadastro.
   - Ao concluir, a conta é ativada e o vínculo com a clínica torna-se ativo imediatamente.
4. **Autenticação em dois fatores (2FA) não obrigatória**:
   - O usuário não é forçado a configurar ou ativar MFA/TOTP no cadastro ou no login.
   - O usuário recebe uma sessão autenticada pronta para uso imediatamente após criar a senha pelo convite.
   - Usuários que optarem voluntariamente por ativar MFA continuam tendo a proteção do segundo fator, mas quem não ativou utiliza o sistema normalmente com sua senha.

## Estrutura de dados

A tabela `organization_invitations` (migration `031_company_invitations`) armazena:
- `organization_id`: referência à clínica emissora;
- `role_id`: função atribuída ao convidado;
- `email_normalized`: e-mail reservado para o convite (ou nulo em convites abertos);
- `token_hash`: SHA-256 do token opaco de uso único;
- `token_ciphertext`: token cifrado com AES-256-GCM para permitir reexibição do link e QR Code por gestores autorizados;
- `status`: `pending`, `accepted`, `revoked` ou `expired`;
- `expires_at`: validade do convite (padrão de 7 dias);
- `accepted_at` e `accepted_by_user_id`: registro de consumo do convite.

A tabela é protegida e inacessível ao papel `clinicflow_app`, mantendo o isolamento de credenciais e segurança de identidade.

## API

| Método e rota | Descrição |
| --- | --- |
| `GET /api/auth/invitations/lookup?token=...` | Consulta pública (com rate limit) dos dados do convite para exibição na tela de cadastro. |
| `POST /api/auth/register` | Cria a conta utilizando `{ inviteToken, email, password }` sem criar organização e sem forçar MFA. |
| `POST /api/organizations/:id/memberships` | Cria convite com token opaco, link e registro em `organization_invitations`. |
| `GET /api/organizations/:id/memberships` | Retorna vínculos, incluindo link e token decifrado para convites pendentes. |
| `DELETE /api/organizations/:id/memberships/:id` | Revoga o vínculo e invalida os convites pendentes associados. |
