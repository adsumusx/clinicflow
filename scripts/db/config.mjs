const localDefaultUrl =
  'postgresql://clinicflow_admin:clinicflow_admin_local@localhost:5433/clinicflow'

export function getDatabaseUrl() {
  if (process.env.DATABASE_URL) {
    return process.env.DATABASE_URL
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATABASE_URL é obrigatória em produção.')
  }

  return localDefaultUrl
}

export function assertLocalReset(databaseUrl) {
  const url = new URL(databaseUrl)
  const localHosts = new Set(['localhost', '127.0.0.1', '::1'])
  const localDatabases = new Set([
    'clinicflow',
    'clinicflow_dev',
    'clinicflow_development',
    'clinicflow_test',
  ])
  const databaseName = url.pathname.replace(/^\//, '')

  if (
    process.env.NODE_ENV === 'production' ||
    !localHosts.has(url.hostname) ||
    !localDatabases.has(databaseName)
  ) {
    throw new Error(
      'Reset recusado: use ambiente não produtivo, host local e um banco ClinicFlow de desenvolvimento permitido.',
    )
  }
}
