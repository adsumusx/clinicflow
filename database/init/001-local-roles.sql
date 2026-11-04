-- Papel local sem privilégios administrativos. Credencial somente de desenvolvimento.
CREATE ROLE clinicflow_app
  LOGIN
  PASSWORD 'clinicflow_app_local'
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOINHERIT
  NOBYPASSRLS;
