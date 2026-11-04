DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE users, sessions, trusted_devices TO clinicflow_app;
  END IF;
END;
$$;
