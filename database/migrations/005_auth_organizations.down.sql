DROP TRIGGER IF EXISTS user_credentials_set_updated_at ON user_credentials;
DROP INDEX IF EXISTS password_reset_tokens_active_idx;
DROP TABLE IF EXISTS password_reset_tokens;
DROP TABLE IF EXISTS user_credentials;
ALTER TABLE sessions DROP COLUMN IF EXISTS organization_id;
