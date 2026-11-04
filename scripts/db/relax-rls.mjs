import pg from 'pg'
import { getDatabaseUrl } from './config.mjs'

const { Client } = pg

async function relaxRowSecurity() {
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  try {
    const role = await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    )
    if (role.rows[0]?.rolsuper || role.rows[0]?.rolbypassrls) {
      console.log('RLS permanece ativa porque a conexão administrativa já a ignora')
      return
    }

    await client.query(`
      DO $$
      DECLARE relation record;
      BEGIN
        FOR relation IN
          SELECT cls.relname
          FROM pg_class cls
          JOIN pg_namespace namespace ON namespace.oid = cls.relnamespace
          WHERE namespace.nspname = 'public'
            AND cls.relkind = 'r'
            AND cls.relrowsecurity
        LOOP
          EXECUTE format('ALTER TABLE %I DISABLE ROW LEVEL SECURITY', relation.relname);
        END LOOP;
      END;
      $$;
    `)
    console.log('RLS desativada: o usuário do banco gratuito não pode ignorá-la e a API usa a conexão administrativa')
  } finally {
    await client.end()
  }
}

relaxRowSecurity().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
