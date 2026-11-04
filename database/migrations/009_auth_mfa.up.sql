ALTER TABLE sessions
  ADD COLUMN mfa_verified_at timestamptz;

CREATE TABLE mfa_totp_factors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  secret_encrypted text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  verified_at timestamptz NOT NULL,
  last_used_step bigint,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

CREATE TABLE mfa_recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash text NOT NULL UNIQUE,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE mfa_challenges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  purpose text NOT NULL CHECK (purpose IN ('enrollment', 'authentication')),
  secret_encrypted text,
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK ((purpose = 'enrollment') = (secret_encrypted IS NOT NULL))
);

CREATE INDEX mfa_challenges_active_idx
  ON mfa_challenges (user_id, expires_at)
  WHERE consumed_at IS NULL;

CREATE INDEX mfa_recovery_codes_available_idx
  ON mfa_recovery_codes (user_id)
  WHERE used_at IS NULL;

CREATE TRIGGER mfa_totp_factors_set_updated_at
  BEFORE UPDATE ON mfa_totp_factors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Fatores, desafios e códigos de recuperação são dados globais de
-- identidade e nunca ficam disponíveis ao papel de consultas de negócio.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    REVOKE ALL ON TABLE mfa_totp_factors, mfa_recovery_codes, mfa_challenges FROM clinicflow_app;
  END IF;
END;
$$;
