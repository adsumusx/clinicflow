import pg from 'pg'
import { getDatabaseUrl } from './config.mjs'
import { readMigrations } from './files.mjs'

const { Client } = pg
const lockId = 737102002

async function ensureHistory(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)
}

async function migrateUp(client, migrations) {
  const result = await client.query('SELECT version FROM schema_migrations')
  const applied = new Set(result.rows.map((row) => row.version))

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue

    await client.query('BEGIN')
    try {
      await client.query(migration.up)
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [migration.version],
      )
      await client.query('COMMIT')
      console.log(`aplicada ${migration.version}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
}

async function migrateDown(client, migrations, all) {
  const result = await client.query(
    'SELECT version FROM schema_migrations ORDER BY version DESC',
  )
  const versions = all ? result.rows : result.rows.slice(0, 1)

  for (const row of versions) {
    const migration = migrations.find((item) => item.version === row.version)
    if (!migration) throw new Error(`Arquivo ausente para ${row.version}.`)

    await client.query('BEGIN')
    try {
      await client.query(migration.down)
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [row.version])
      await client.query('COMMIT')
      console.log(`revertida ${row.version}`)
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
}

export async function runMigrations(direction = 'up', all = false) {
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()

  try {
    await client.query('SELECT pg_advisory_lock($1)', [lockId])
    await ensureHistory(client)
    const migrations = await readMigrations()

    if (direction === 'down') await migrateDown(client, migrations, all)
    else await migrateUp(client, migrations)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => undefined)
    await client.end()
  }
}

const direction = process.argv[2] === 'down' ? 'down' : 'up'
const all = process.argv.includes('--all')

runMigrations(direction, all).catch((error) => {
  console.error(error)
  process.exitCode = 1
})
