import { execFileSync } from 'node:child_process'
import { assertLocalReset, getDatabaseUrl } from './config.mjs'

assertLocalReset(getDatabaseUrl())

const options = { cwd: process.cwd(), env: process.env, stdio: 'inherit' }
execFileSync(process.execPath, ['scripts/db/migrate.mjs', 'down', '--all'], options)
execFileSync(process.execPath, ['scripts/db/migrate.mjs', 'up'], options)
execFileSync(process.execPath, ['scripts/db/seed.mjs'], options)
