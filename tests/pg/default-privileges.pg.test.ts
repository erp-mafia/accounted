import { randomUUID } from 'crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Client, type ClientBase, type PoolClient } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { getClient, getPool } from './setup'

/**
 * 20260929220000_own_default_privileges: a new public table or sequence gets
 * no privileges for anon, authenticated or service_role until its migration
 * grants them, which is how every Supabase project behaves from 2026-10-30.
 * Tables created before it keep the ACL the old default gave them, and
 * supabase/bootstrap.sql lets a fresh database (a project created since
 * 2026-05-30, which never had the old default) replay the history into that
 * same state.
 */

const ROOT = path.resolve(__dirname, '..', '..')
const MIGRATION_SQL = readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260929220000_own_default_privileges.sql'),
  'utf8',
)
const BOOTSTRAP_SQL = readFileSync(path.join(ROOT, 'supabase', 'bootstrap.sql'), 'utf8')

const API_ROLES = ['anon', 'authenticated', 'service_role']
const TABLE_PRIVILEGES = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']

type Queryable = Pick<ClientBase, 'query'>

/** What the default ACL of `postgres` in public hands each API role, for one object type. */
async function defaultGrants(q: Queryable, objtype: 'r' | 'S' | 'f'): Promise<string[]> {
  const { rows } = await q.query<{ grant: string }>(
    `SELECT g.rolname || ':' || a.privilege_type AS grant
       FROM pg_default_acl d
       CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       JOIN pg_roles g ON g.oid = a.grantee
      WHERE d.defaclrole = 'postgres'::regrole
        AND d.defaclnamespace = 'public'::regnamespace
        AND d.defaclobjtype = $1
        AND g.rolname = ANY($2)
      ORDER BY 1`,
    [objtype, API_ROLES],
  )
  return rows.map((r) => r.grant)
}

/** Every (role, privilege) pair the API roles hold on a relation. */
async function tablePrivileges(q: Queryable, relation: string): Promise<string[]> {
  const { rows } = await q.query<{ grant: string }>(
    `SELECT r || ':' || p AS grant
       FROM unnest($2::text[]) r, unnest($3::text[]) p
      WHERE has_table_privilege(r, $1::regclass, p)
      ORDER BY 1`,
    [relation, API_ROLES, TABLE_PRIVILEGES],
  )
  return rows.map((r) => r.grant)
}

/** Run one statement as `role` inside a savepoint; resolves to the SQLSTATE, or 'ok'. */
async function attemptAs(client: PoolClient, role: string, sql: string): Promise<string> {
  await client.query('SAVEPOINT attempt')
  try {
    await client.query(`SET LOCAL ROLE ${role}`)
    await client.query(sql)
    return 'ok'
  } catch (err) {
    return (err as { code?: string }).code ?? String(err)
  } finally {
    await client.query('ROLLBACK TO SAVEPOINT attempt')
    await client.query('RESET ROLE')
  }
}

/** Run `fn` in a transaction that is always rolled back. */
async function inRolledBackTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient()
  try {
    await client.query('BEGIN')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

describe('default privileges after the full replay', () => {
  it('grants no API role anything on new public tables or sequences', async () => {
    expect(await defaultGrants(getPool(), 'r')).toEqual([])
    expect(await defaultGrants(getPool(), 'S')).toEqual([])
  })

  it('gives a new table no privileges until an explicit GRANT, then exactly that grant', async () => {
    const table = `public.odp_probe_${randomUUID().slice(0, 8)}`
    await inRolledBackTx(async (client) => {
      await client.query(`CREATE TABLE ${table} (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), note text)`)
      expect(await tablePrivileges(client, table)).toEqual([])

      // What supabase-js would have hit: 42501, the service-role client included.
      expect(await attemptAs(client, 'service_role', `INSERT INTO ${table} (note) VALUES ('x')`)).toBe('42501')
      expect(await attemptAs(client, 'authenticated', `SELECT * FROM ${table}`)).toBe('42501')
      expect(await attemptAs(client, 'anon', `SELECT * FROM ${table}`)).toBe('42501')

      await client.query(`GRANT SELECT, INSERT ON ${table} TO service_role`)
      expect(await tablePrivileges(client, table)).toEqual(['service_role:INSERT', 'service_role:SELECT'])
      expect(await attemptAs(client, 'service_role', `INSERT INTO ${table} (note) VALUES ('x')`)).toBe('ok')
      expect(await attemptAs(client, 'authenticated', `SELECT * FROM ${table}`)).toBe('42501')
    })
  })

  it('lets an identity key insert without a sequence grant, while a serial key needs one', async () => {
    const suffix = randomUUID().slice(0, 8)
    const identity = `public.odp_identity_${suffix}`
    const serial = `public.odp_serial_${suffix}`
    await inRolledBackTx(async (client) => {
      await client.query(`CREATE TABLE ${identity} (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, note text)`)
      await client.query(`CREATE TABLE ${serial} (id bigserial PRIMARY KEY, note text)`)
      await client.query(`GRANT SELECT, INSERT ON ${identity}, ${serial} TO service_role`)

      expect(await attemptAs(client, 'service_role', `INSERT INTO ${identity} (note) VALUES ('x')`)).toBe('ok')
      expect(await attemptAs(client, 'service_role', `INSERT INTO ${serial} (note) VALUES ('x')`)).toBe('42501')

      await client.query(`GRANT USAGE, SELECT ON SEQUENCE public.odp_serial_${suffix}_id_seq TO service_role`)
      expect(await attemptAs(client, 'service_role', `INSERT INTO ${serial} (note) VALUES ('x')`)).toBe('ok')
    })
  })

  it('keeps the grants the old default gave historical tables, and the lockdowns later migrations made', async () => {
    const pool = getPool()
    const has = async (role: string, relation: string, privilege: string) =>
      (
        await pool.query<{ ok: boolean }>(`SELECT has_table_privilege($1, $2::regclass, $3) AS ok`, [
          role,
          relation,
          privilege,
        ])
      ).rows[0].ok

    // Created with no GRANT under the old default: still reachable.
    for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
      expect(await has('service_role', 'public.journal_entries', privilege)).toBe(true)
      expect(await has('authenticated', 'public.journal_entries', privilege)).toBe(true)
      expect(await has('service_role', 'public.companies', privilege)).toBe(true)
    }
    const seq = await pool.query<{ ok: boolean }>(
      `SELECT has_sequence_privilege('service_role', 'public.event_log_sequence_seq', 'USAGE') AS ok`,
    )
    expect(seq.rows[0].ok).toBe(true)

    // Deliberately revoked by later migrations: still revoked.
    expect(await has('service_role', 'public.ai_usage_events', 'INSERT')).toBe(true)
    expect(await has('authenticated', 'public.ai_usage_events', 'SELECT')).toBe(false)
    expect(await has('authenticated', 'public.api_key_companies', 'SELECT')).toBe(false)
    expect(await has('service_role', 'public.sie_period_read_leases', 'SELECT')).toBe(false)
  })

  it('leaves the bootstrap inert on a database that already has the history applied', async () => {
    await inRolledBackTx(async (client) => {
      await client.query(BOOTSTRAP_SQL)
      expect(await defaultGrants(client, 'r')).toEqual([])
      expect(await defaultGrants(client, 'S')).toEqual([])
    })
  })
})

describe('supabase/bootstrap.sql on a fresh database', () => {
  // A new database has no pg_default_acl rows at all, which is exactly what a
  // Supabase project created since 2026-05-30 looks like to the postgres role:
  // tables it creates are reachable by nobody but itself.
  const dbName = `odp_fresh_${randomUUID().replace(/-/g, '').slice(0, 12)}`
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/postgres')
  url.pathname = `/${dbName}`
  let fresh: Client | null = null

  afterAll(async () => {
    await fresh?.end().catch(() => {})
    await getPool().query(`DROP DATABASE IF EXISTS ${dbName}`)
  })

  it('replays history with the legacy grants, then 20260929220000 turns them off for what comes after', async () => {
    await getPool().query(`CREATE DATABASE ${dbName} TEMPLATE template0`)
    const db = new Client({ connectionString: url.toString() })
    fresh = db
    await db.connect()

    // Without the bootstrap: the broken fresh replay, no grants at all.
    await db.query(`CREATE TABLE public.before_bootstrap (id int)`)
    expect(await tablePrivileges(db, 'public.before_bootstrap')).toEqual([])

    // With it: a historical migration's CREATE TABLE behaves as it did in production.
    await db.query(BOOTSTRAP_SQL)
    await db.query(`CREATE TABLE public.historical (id bigserial PRIMARY KEY)`)
    const historical = await tablePrivileges(db, 'public.historical')
    for (const role of API_ROLES) {
      for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
        expect(historical).toContain(`${role}:${privilege}`)
      }
    }
    const seq = await db.query<{ ok: boolean }>(
      `SELECT has_sequence_privilege('service_role', 'public.historical_id_seq', 'USAGE') AS ok`,
    )
    expect(seq.rows[0].ok).toBe(true)

    // The end-of-chain migration: later tables get nothing, earlier ones keep theirs.
    await db.query(MIGRATION_SQL)
    await db.query(`CREATE TABLE public.after_migration (id int)`)
    expect(await tablePrivileges(db, 'public.after_migration')).toEqual([])
    expect(await tablePrivileges(db, 'public.historical')).toEqual(historical)
    expect(await defaultGrants(db, 'r')).toEqual([])
    expect(await defaultGrants(db, 'S')).toEqual([])

    // Once the history exists, running the bootstrap again must not re-open the defaults.
    await db.query(`CREATE TABLE public.companies (id uuid PRIMARY KEY)`)
    await db.query(BOOTSTRAP_SQL)
    expect(await defaultGrants(db, 'r')).toEqual([])
    await db.query(`CREATE TABLE public.after_rerun (id int)`)
    expect(await tablePrivileges(db, 'public.after_rerun')).toEqual([])
  })
})
