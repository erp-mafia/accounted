import { describe, expect, it } from 'vitest'
import { getPool } from './setup'

// pg-real for migration 20261118070101: the tables and functions of the in-app
// connector proxy are gone, and what an installation still uses is not.

const DROPPED_TABLES = [
  'connector_usage_events',
  'connector_connections',
  'connector_upstream_counters',
  'connector_keys',
]

const DROPPED_FUNCTIONS = ['validate_and_increment_connector_key', 'connector_reserve_upstream']

describe('drop hosted connector tables (pg)', () => {
  it('drops the four tables', async () => {
    const { rows } = await getPool().query<{ name: string; reg: string | null }>(
      `SELECT name, to_regclass('public.' || name)::text AS reg FROM unnest($1::text[]) AS name`,
      [DROPPED_TABLES],
    )
    expect(rows.filter((r) => r.reg !== null).map((r) => r.name)).toEqual([])
  })

  it('drops the key check and the upstream budget functions', async () => {
    const { rows } = await getPool().query<{ proname: string }>(
      `SELECT p.proname
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'public' AND p.proname = ANY($1::text[])`,
      [DROPPED_FUNCTIONS],
    )
    expect(rows).toEqual([])
  })

  it('keeps the grants table an installation writes its connector grants to', async () => {
    const { rows } = await getPool().query<{ reg: string | null }>(
      `SELECT to_regclass('public.capability_grants')::text AS reg`,
    )
    expect(rows[0].reg).toBe('capability_grants')
  })
})
