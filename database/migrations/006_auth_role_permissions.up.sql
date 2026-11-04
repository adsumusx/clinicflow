-- Reaplica explicitamente as restrições para bancos que já haviam recebido a
-- migration 005 antes do endurecimento das permissões de identidade.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE ALL ON TABLE users, sessions, trusted_devices, user_credentials, password_reset_tokens FROM clinicflow_app;
  END IF;
END;
$$;
