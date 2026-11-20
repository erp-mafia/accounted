import { Client } from 'pg'
import { TEMPLATE_DATABASE, baseDatabaseUrl, databaseOf, withDatabase, workerCount, workerDatabase } from './parallel'

/**
 * Runs once before the pg-real project. With PG_REAL_WORKERS set it copies the
 * migrated database: first into a template nothing connects to, then from the
 * template into one database per worker. Postgres copies a database only
 * while no other session is connected to it, and the migrated database always
 * has some (the image's background workers), hence the template in between.
 * Returns the teardown that drops the copies.
 */

const OBJECT_IN_USE = '55006'

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`
}

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url })
  await client.connect()
  return client
}

/**
 * A superuser session on the maintenance database. The suite's own login is
 * not a superuser in the supabase/postgres image, and only a superuser may
 * copy a database it does not own or end another role's session. The image's
 * superuser, supabase_admin, has the same password.
 */
async function connectAsAdmin(base: string): Promise<Client> {
  const maintenance = withDatabase(base, 'template1')
  const own = await connect(maintenance)
  const { rows } = await own.query<{ rolsuper: boolean }>('SELECT rolsuper FROM pg_roles WHERE rolname = current_user')
  if (rows[0]?.rolsuper) return own
  const asAdmin = new URL(maintenance)
  asAdmin.username = 'supabase_admin'
  try {
    const admin = await connect(asAdmin.toString())
    await own.end()
    return admin
  } catch {
    // No such login on this server: go on with the suite's own and let the
    // server say what it may not do.
    return own
  }
}

/** Copy `source` into `target`, ending the sessions that hold `source` first. */
async function copyDatabase(admin: Client, source: string, target: string, endSessions: boolean): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    if (endSessions) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()', [source])
    }
    try {
      await admin.query(`CREATE DATABASE ${quoteIdent(target)} TEMPLATE ${quoteIdent(source)}`)
      return
    } catch (error) {
      // A background worker reconnected between the two statements.
      if ((error as { code?: string }).code !== OBJECT_IN_USE || attempt >= 20) throw error
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  }
}

/**
 * CREATE DATABASE copies the contents, not what the catalog keeps about the
 * database itself: its owner and the settings made with ALTER DATABASE or
 * ALTER ROLE ... IN DATABASE.
 */
async function copyDatabaseSettings(admin: Client, source: string, target: string): Promise<void> {
  const owner = await admin.query<{ owner: string }>(
    'SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1',
    [source],
  )
  if (owner.rows[0]) await admin.query(`ALTER DATABASE ${quoteIdent(target)} OWNER TO ${quoteIdent(owner.rows[0].owner)}`)

  // The catalog rows themselves, not ALTER ... SET rebuilt from them: a list
  // value such as search_path would need the quoting pg_dump knows per
  // setting, and the rows already hold the stored form.
  await admin.query(
    `INSERT INTO pg_db_role_setting (setdatabase, setrole, setconfig)
     SELECT t.oid, s.setrole, s.setconfig
       FROM pg_db_role_setting s
       JOIN pg_database d ON d.oid = s.setdatabase
       JOIN pg_database t ON t.datname = $2
      WHERE d.datname = $1`,
    [source, target],
  )
}

async function dropCopies(admin: Client, workers: number): Promise<void> {
  for (let slot = 1; slot <= workers; slot += 1) {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(workerDatabase(slot))} WITH (FORCE)`)
  }
  await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(TEMPLATE_DATABASE)} WITH (FORCE)`)
}

export default async function setup(): Promise<(() => Promise<void>) | void> {
  const workers = workerCount()
  if (workers === 0) return

  const base = baseDatabaseUrl()
  const source = databaseOf(base)
  const admin = await connectAsAdmin(base)
  try {
    const started = Date.now()
    await dropCopies(admin, workers)
    await copyDatabase(admin, source, TEMPLATE_DATABASE, true)
    for (let slot = 1; slot <= workers; slot += 1) {
      await copyDatabase(admin, TEMPLATE_DATABASE, workerDatabase(slot), false)
      await copyDatabaseSettings(admin, source, workerDatabase(slot))
    }
    console.log(`pg-real: ${workers} worker databases copied from ${source} in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
  } finally {
    await admin.end().catch(() => {})
  }

  return async () => {
    const cleaner = await connectAsAdmin(base)
    try {
      await dropCopies(cleaner, workers)
    } finally {
      await cleaner.end().catch(() => {})
    }
  }
}
