import { spawn } from 'node:child_process'

function runNode(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { stdio: 'inherit', env: process.env })
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${script} encerrou com código ${code}`))
    })
  })
}

if (process.env.RENDER_EXTERNAL_URL && !process.env.PASSWORD_RESET_BASE_URL) {
  process.env.PASSWORD_RESET_BASE_URL = `${process.env.RENDER_EXTERNAL_URL}/#reset-password`
}

await runNode('scripts/db/prepare-database.mjs')
await runNode('scripts/db/migrate.mjs')
await runNode('scripts/db/relax-rls.mjs')
await runNode('scripts/db/bootstrap-organization.mjs')
await runNode('server/index.mjs')
