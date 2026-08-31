import { describe, it, expect } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

// pg-real coverage for migration 20260831190000 (connector_keys,
// connector_usage_events, validate_and_increment_connector_key): the atomic
// validate + rate-limit path, the suspended/revoked answers, and the
// service-role-only exposure (no RLS policy, RPC not executable by anon or
// authenticated). Required by .claude/rules/database.md for RPC/RLS changes.

function hashOf(key: string): string {
  return createHash('sha256').update(key).digest('hex')
}

async function insertKey(p: {
  status?: string
  rpm?: number
  revoked?: boolean
  scopes?: string[]
  periodEnd?: string | null
}): Promise<{ id: string; key: string; hash: string }> {
  const key = `gnubok_ck_${randomBytes(32).toString('base64url')}`
  const hash = hashOf(key)
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.connector_keys
       (key_hash, key_prefix, org_number, licensee_name, instance_url, scopes, status, rate_limit_rpm, current_period_end, revoked_at)
     VALUES ($1, $2, '5561234567', 'Byrå AB', 'https://bokforing.example.se', $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      hash,
      key.slice(0, 18),
      p.scopes ?? ['bank_sync', 'skatteverket', 'org_lookup', 'migration'],
      p.status ?? 'active',
      p.rpm ?? 600,
      p.periodEnd === undefined ? null : p.periodEnd,
      p.revoked ? new Date().toISOString() : null,
    ],
  )
  return { id: rows[0].id, key, hash }
}

type RpcRow = {
  connector_key_id: string
  org_number: string
  instance_url: string | null
  scopes: string[]
  status: string
  current_period_end: Date | null
  rate_limited: boolean
}

async function rpc(hash: string): Promise<RpcRow[]> {
  const { rows } = await getPool().query<RpcRow>(
    `SELECT * FROM public.validate_and_increment_connector_key($1)`,
    [hash],
  )
  return rows
}

describe('validate_and_increment_connector_key', () => {
  it('returns the key row and counts the request', async () => {
    const { id, hash } = await insertKey({ periodEnd: '2027-01-01T00:00:00Z' })
    const rows = await rpc(hash)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      connector_key_id: id,
      org_number: '5561234567',
      instance_url: 'https://bokforing.example.se',
      status: 'active',
      rate_limited: false,
    })
    expect(rows[0].scopes).toEqual(['bank_sync', 'skatteverket', 'org_lookup', 'migration'])
    const { rows: after } = await getPool().query<{ request_count: number; last_seen_at: Date | null }>(
      `SELECT request_count, last_seen_at FROM public.connector_keys WHERE id = $1`,
      [id],
    )
    expect(after[0].request_count).toBe(1)
    expect(after[0].last_seen_at).not.toBeNull()
  })

  it('returns nothing for an unknown hash and for a revoked key', async () => {
    expect(await rpc(hashOf('gnubok_ck_nope'))).toEqual([])
    const revoked = await insertKey({ revoked: true, status: 'revoked' })
    expect(await rpc(revoked.hash)).toEqual([])
  })

  it('reports a suspended key without counting it', async () => {
    const { id, hash } = await insertKey({ status: 'suspended' })
    const rows = await rpc(hash)
    expect(rows[0]).toMatchObject({ status: 'suspended', rate_limited: false })
    const { rows: after } = await getPool().query<{ request_count: number }>(
      `SELECT request_count FROM public.connector_keys WHERE id = $1`,
      [id],
    )
    expect(after[0].request_count).toBe(0)
  })

  it('rate-limits inside the minute window', async () => {
    const { hash } = await insertKey({ rpm: 2 })
    expect((await rpc(hash))[0].rate_limited).toBe(false)
    expect((await rpc(hash))[0].rate_limited).toBe(false)
    expect((await rpc(hash))[0].rate_limited).toBe(true)
  })

  it('is executable by service_role only', async () => {
    const { rows } = await getPool().query<{ role: string; ok: boolean }>(
      `SELECT r.role, has_function_privilege(r.role, 'public.validate_and_increment_connector_key(text)', 'execute') AS ok
         FROM (VALUES ('anon'), ('authenticated'), ('service_role')) AS r(role)`,
    )
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.ok]))
    expect(byRole).toEqual({ anon: false, authenticated: false, service_role: true })
  })
})

describe('connector tables are service-role only', () => {
  it('an authenticated user sees no connector keys or usage rows', async () => {
    await insertKey({})
    const userId = await insertAuthUser()
    await withUserContext(userId, async (client) => {
      const keys = await client.query(`SELECT id FROM public.connector_keys`)
      expect(keys.rowCount).toBe(0)
      const usage = await client.query(`SELECT id FROM public.connector_usage_events`)
      expect(usage.rowCount).toBe(0)
    })
  })

  it('usage rows cascade with their key', async () => {
    const { id } = await insertKey({})
    await getPool().query(
      `INSERT INTO public.connector_usage_events (connector_key_id, service, endpoint, status_code)
       VALUES ($1, 'entitlements', '/api/connect/entitlements', 200)`,
      [id],
    )
    await getPool().query(`DELETE FROM public.connector_keys WHERE id = $1`, [id])
    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.connector_usage_events WHERE connector_key_id = $1`,
      [id],
    )
    expect(rows[0].n).toBe(0)
  })
})
