DROP TRIGGER IF EXISTS mfa_totp_factors_set_updated_at ON mfa_totp_factors;
DROP INDEX IF EXISTS mfa_recovery_codes_available_idx;
DROP INDEX IF EXISTS mfa_challenges_active_idx;
DROP TABLE IF EXISTS mfa_challenges;
DROP TABLE IF EXISTS mfa_recovery_codes;
DROP TABLE IF EXISTS mfa_totp_factors;
ALTER TABLE sessions DROP COLUMN IF EXISTS mfa_verified_at;
