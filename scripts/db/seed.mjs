import pg from 'pg'
import { getDatabaseUrl } from './config.mjs'
import { readDevelopmentSeed } from './files.mjs'

const { Client } = pg

export async function runSeed() {
  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()

  try {
    const seed = await readDevelopmentSeed()
    await client.query('BEGIN')
    await client.query(seed)
    await client.query('COMMIT')
    console.log('seed sintético aplicado')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    await client.end()
  }
}

runSeed().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
