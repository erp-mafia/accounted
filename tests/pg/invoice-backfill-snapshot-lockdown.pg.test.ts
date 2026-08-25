/**
 * pg-real coverage for 20260825170000_lock_down_invoice_backfill_snapshot.sql.
 *
 * The snapshot exists only in production because it was created during a
 * one-time repair. A clean migration replay therefore has no relation to
 * inspect. This suite recreates only its catalog shape and grants inside a
 * transaction, reapplies the idempotent containment migration, and rolls the
 * entire fixture back after the assertions. It never reads production data.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFile } from 'node:fs/promises'
import type { PoolClient } from 'pg'
import { getClient, getPool } from '@/tests/pg/setup'

const SNAPSHOT = 'public._backfill_remaining_20260817'
let fixtureClient: PoolClient

/** Assert grant-layer denial while restoring the fixture transaction after the expected error. */
async function expectSnapshotDenied(
  role: 'anon' | 'authenticated',
  sql: string,
): Promise<void> {
  await fixtureClient.query('SAVEPOINT snapshot_access_attempt')
  try {
    await fixtureClient.query(`SET LOCAL ROLE ${role}`)
    await expect(fixtureClient.query(sql)).rejects.toThrow(/permission denied/i)
  } finally {
    await fixtureClient.query('ROLLBACK TO SAVEPOINT snapshot_access_attempt').catch(() => {})
    await fixtureClient.query('RELEASE SAVEPOINT snapshot_access_attempt').catch(() => {})
  }
}

beforeAll(async () => {
  fixtureClient = await getClient()
  await fixtureClient.query('BEGIN')

  const existing = await fixtureClient.query<{ relation: string | null }>(
    `SELECT to_regclass($1)::text AS relation`,
    [SNAPSHOT],
  )
  if (existing.rows[0]?.relation !== null) {
    throw new Error(
      `Refusing to create the pg-real fixture because ${SNAPSHOT} already exists in this database`,
    )
  }

  await fixtureClient.query(`
    CREATE TABLE ${SNAPSHOT} (
      id uuid,
      remaining_amount numeric,
      total numeric,
      paid_amount numeric,
      deduction_total numeric,
      status text,
      snapshot_at timestamptz
    );
    GRANT ALL PRIVILEGES ON TABLE ${SNAPSHOT} TO anon, authenticated, service_role;
  `)

  const migrationSql = await readFile(
    new URL(
      '../../supabase/migrations/20260825170000_lock_down_invoice_backfill_snapshot.sql',
      import.meta.url,
    ),
    'utf8',
  )
  await fixtureClient.query(migrationSql)
})

afterAll(async () => {
  if (fixtureClient) {
    await fixtureClient.query('ROLLBACK').catch(() => {})
    fixtureClient.release()
  }
})

describe('invoice backfill snapshot lockdown (pg)', () => {
  it('enables RLS and removes browser-role privileges', async () => {
    const flags = await fixtureClient.query<{
      relrowsecurity: boolean
      anon_access: boolean
      authenticated_access: boolean
      service_write_access: boolean
    }>(`
      SELECT
        c.relrowsecurity,
        (
          has_table_privilege('anon', c.oid, 'SELECT')
          OR has_table_privilege('anon', c.oid, 'INSERT')
          OR has_table_privilege('anon', c.oid, 'UPDATE')
          OR has_table_privilege('anon', c.oid, 'DELETE')
        ) AS anon_access,
        (
          has_table_privilege('authenticated', c.oid, 'SELECT')
          OR has_table_privilege('authenticated', c.oid, 'INSERT')
          OR has_table_privilege('authenticated', c.oid, 'UPDATE')
          OR has_table_privilege('authenticated', c.oid, 'DELETE')
        ) AS authenticated_access,
        (
          has_table_privilege('service_role', c.oid, 'INSERT')
          OR has_table_privilege('service_role', c.oid, 'UPDATE')
          OR has_table_privilege('service_role', c.oid, 'DELETE')
          OR has_table_privilege('service_role', c.oid, 'TRUNCATE')
        ) AS service_write_access
      FROM pg_catalog.pg_class c
      WHERE c.oid = '${SNAPSHOT}'::regclass
    `)

    expect(flags.rows).toEqual([
      {
        relrowsecurity: true,
        anon_access: false,
        authenticated_access: false,
        service_write_access: false,
      },
    ])
  })

  it('explicitly denies every browser-role CRUD operation', async () => {
    for (const role of ['anon', 'authenticated'] as const) {
      await expectSnapshotDenied(role, `SELECT * FROM ${SNAPSHOT} LIMIT 1`)
      await expectSnapshotDenied(role, `INSERT INTO ${SNAPSHOT} (status) VALUES ('test')`)
      await expectSnapshotDenied(role, `UPDATE ${SNAPSHOT} SET status = status WHERE false`)
      await expectSnapshotDenied(role, `DELETE FROM ${SNAPSHOT} WHERE false`)
    }
  })

  it('retains privileged access for an authorized retention review', async () => {
    await fixtureClient.query('SAVEPOINT service_role_access')
    try {
      await fixtureClient.query('SET LOCAL ROLE service_role')
      const result = await fixtureClient.query(`SELECT count(*)::int AS count FROM ${SNAPSHOT}`)
      expect(result.rows[0]?.count).toBe(0)
    } finally {
      await fixtureClient.query('ROLLBACK TO SAVEPOINT service_role_access')
      await fixtureClient.query('RELEASE SAVEPOINT service_role_access')
    }
  })

  it('leaves no public table without RLS', async () => {
    const result = await fixtureClient.query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relrowsecurity
      ORDER BY c.relname
    `)
    expect(result.rows).toEqual([])
  })

  it('exposes no temporary backfill, repair, or snapshot table to browser roles', async () => {
    const result = await fixtureClient.query<{ relname: string; role_name: string }>(`
      SELECT c.relname, role_name
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      CROSS JOIN (VALUES ('anon'), ('authenticated')) AS roles(role_name)
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND c.relname ~ '(^_|backfill|repair|snapshot)'
        AND (
          has_table_privilege(role_name, c.oid, 'SELECT')
          OR has_table_privilege(role_name, c.oid, 'INSERT')
          OR has_table_privilege(role_name, c.oid, 'UPDATE')
          OR has_table_privilege(role_name, c.oid, 'DELETE')
        )
      ORDER BY c.relname, role_name
    `)
    expect(result.rows).toEqual([])
  })
})

describe('public-schema RLS invariant (pg)', () => {
  it('holds independently of the incident fixture connection', async () => {
    const result = await getPool().query<{ relname: string }>(`
      SELECT c.relname
      FROM pg_catalog.pg_class c
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT c.relrowsecurity
      ORDER BY c.relname
    `)
    expect(result.rows).toEqual([])
  })
})
