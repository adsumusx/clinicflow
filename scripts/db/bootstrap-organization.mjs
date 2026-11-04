import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { hashPassword } from '../../server/security.mjs'
import { getDatabaseUrl } from './config.mjs'

const { Client } = pg

const roleDefinitions = [
  ['owner', 'Proprietário', true],
  ['admin', 'Administrador', true],
  ['professional', 'Profissional', false],
  ['reception_finance', 'Recepção/Financeiro', false],
  ['client', 'Cliente', false],
]

export async function bootstrapOrganization() {
  if (process.env.BOOTSTRAP_ENABLED !== '1') {
    console.log('bootstrap de clínica desativado')
    return
  }

  const organizationName = process.env.BOOTSTRAP_ORG_NAME?.trim()
  const email = process.env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase()
  const password = process.env.BOOTSTRAP_ADMIN_PASSWORD
  if (!organizationName || !email || !password || password.length < 12) {
    throw new Error('Defina BOOTSTRAP_ORG_NAME, BOOTSTRAP_ADMIN_EMAIL e BOOTSTRAP_ADMIN_PASSWORD (mínimo de 12 caracteres).')
  }

  const client = new Client({ connectionString: getDatabaseUrl() })
  await client.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      `SELECT id FROM organizations WHERE trade_name = $1 AND deleted_at IS NULL`,
      [organizationName],
    )
    let organizationId = existing.rows[0]?.id
    if (!organizationId) {
      const organization = await client.query(
        `INSERT INTO organizations (legal_name, trade_name, status)
         VALUES ($1, $1, 'active') RETURNING id`,
        [organizationName],
      )
      organizationId = organization.rows[0].id
      for (const [code, roleName, privileged] of roleDefinitions) {
        await client.query(
          `INSERT INTO roles (organization_id, code, name, privileged)
           VALUES ($1, $2, $3, $4)`,
          [organizationId, code, roleName, privileged],
        )
      }
      await client.query(
        `INSERT INTO role_permissions (organization_id, role_id, permission_id)
         SELECT $1, role.id, defaults.permission_id
         FROM roles role
         JOIN role_permission_defaults defaults ON defaults.role_code = role.code
         WHERE role.organization_id = $1`,
        [organizationId],
      )
      await client.query(
        `INSERT INTO units (organization_id, name, timezone, address)
         VALUES ($1, 'Matriz', 'America/Sao_Paulo', '{"city":"","state":""}'::jsonb)`,
        [organizationId],
      )
      await client.query(
        `INSERT INTO financial_categories (organization_id, kind, name)
         VALUES ($1, 'receivable', 'Geral')`,
        [organizationId],
      )
      console.log(`clínica criada: ${organizationName}`)
    }

    const adminRole = await client.query(
      `SELECT id FROM roles WHERE organization_id = $1 AND code = 'admin'`,
      [organizationId],
    )
    if (!adminRole.rowCount) throw new Error('A função admin não existe nesta clínica.')

    const account = await client.query(
      `SELECT id FROM users WHERE email_normalized = $1`,
      [email],
    )
    let userId = account.rows[0]?.id
    if (!userId) {
      userId = randomUUID()
      const passwordHash = await hashPassword(password)
      await client.query(
        `INSERT INTO users (id, identity_provider_subject, email_normalized, status)
         VALUES ($1, $2, $3, 'active')`,
        [userId, `local:${userId}`, email],
      )
      await client.query(
        `INSERT INTO user_credentials (user_id, password_hash) VALUES ($1, $2)`,
        [userId, passwordHash],
      )
      console.log(`administrador criado: ${email}`)
    }

    const membership = await client.query(
      `SELECT id, status FROM memberships
       WHERE organization_id = $1 AND user_id = $2 AND status <> 'revoked'`,
      [organizationId, userId],
    )
    if (!membership.rowCount) {
      const created = await client.query(
        `INSERT INTO memberships (organization_id, user_id, role_id, status)
         VALUES ($1, $2, $3, 'active') RETURNING id`,
        [organizationId, userId, adminRole.rows[0].id],
      )
      await client.query(
        `INSERT INTO audit_events
          (organization_id, actor_membership_id, action, target_type, target_id, minimal_metadata)
         VALUES ($1, $2, 'organization.bootstrapped', 'organization', $1, '{"origin":"bootstrap"}'::jsonb)`,
        [organizationId, created.rows[0].id],
      )
    }
    await client.query('COMMIT')
    console.log('clínica e administrador prontos')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    await client.end()
  }
}

const invokedDirectly = process.argv[1]?.replaceAll('\\', '/').endsWith('scripts/db/bootstrap-organization.mjs')
if (invokedDirectly) {
  bootstrapOrganization().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
