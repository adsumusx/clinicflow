import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'

const migrationsDirectory = resolve('database/migrations')

export async function readMigrations() {
  const fileNames = await readdir(migrationsDirectory)
  const upFiles = fileNames.filter((name) => name.endsWith('.up.sql')).sort()

  return Promise.all(
    upFiles.map(async (upFile) => {
      const version = upFile.replace(/\.up\.sql$/, '')
      const downFile = `${version}.down.sql`

      if (!fileNames.includes(downFile)) {
        throw new Error(`Migration ${version} não possui arquivo down.`)
      }

      return {
        version,
        up: await readFile(resolve(migrationsDirectory, upFile), 'utf8'),
        down: await readFile(resolve(migrationsDirectory, downFile), 'utf8'),
      }
    }),
  )
}

export async function readDevelopmentSeed() {
  return readFile(resolve('database/seeds/development.sql'), 'utf8')
}
