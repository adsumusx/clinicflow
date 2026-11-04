import pg from 'pg'
import { getDatabaseUrl } from './config.mjs'

const { Client } = pg

async function prepareDatabase() {
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clinicflow_app') THEN
          CREATE ROLE clinicflow_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END;
      $$;
    `).catch((error) => {
      console.warn(`papel clinicflow_app não criado: ${error.message}`)
    })

    const role = await client.query(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    )
    const current = role.rows[0]
    if (current?.rolsuper || current?.rolbypassrls) {
      console.log('conexão administrativa ignora RLS')
      return
    }

    await client.query('ALTER ROLE CURRENT_USER BYPASSRLS')
    console.log('BYPASSRLS aplicado à conexão administrativa')
  } finally {
    await client.end()
  }
}

prepareDatabase().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
