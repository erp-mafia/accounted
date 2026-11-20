import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getClient, getPool, runAsServiceRole, withUserContext } from './setup'
import { insertAuthUser } from './fixtures'

/**
 * reserve_external_call and the external_call_* tables
 * (20261029200000_external_call_budget.sql).
 *
 * Locks in:
 *   - a reservation increments the cycle total, the purpose and (with a
 *     subject cap) the subject's day, and a refusal increments none of them;
 *   - each cap (total, purpose, subject per day) refuses with its scope;
 *   - under concurrency exactly the cap is granted, never one more;
 *   - '_total' is not a purpose a caller may name;
 *   - only service_role may execute the RPC or touch the tables.
 */

const CYCLE = '2026-10-22'

function freshProvider(): string {
  return `t_${randomUUID().replace(/-/g, '').slice(0, 16)}`
}

type Reservation = { ok: boolean; scope?: string; total_calls?: number }

async function reserve(
  provider: string,
  purpose: string,
  purposeCap: number | null,
  totalCap: number,
  subject: string | null = null,
  subjectCap: number | null = null,
): Promise<Reservation> {
  const res = await getPool().query<{ r: Reservation }>(
    `SELECT public.reserve_external_call($1, $2::date, $3, $4, $5, $6, $7) AS r`,
    [provider, CYCLE, purpose, purposeCap, totalCap, subject, subjectCap],
  )
  return res.rows[0]!.r
}

async function calls(provider: string, purpose: string): Promise<number> {
  const res = await getPool().query<{ calls: number }>(
    `SELECT calls FROM public.external_call_budget WHERE provider = $1 AND cycle_start = $2::date AND purpose = $3`,
    [provider, CYCLE, purpose],
  )
  return res.rows[0]?.calls ?? 0
}

async function subjectCalls(provider: string, purpose: string, subject: string): Promise<number> {
  const res = await getPool().query<{ calls: number }>(
    `SELECT COALESCE(SUM(calls), 0)::int AS calls FROM public.external_call_subject_daily
      WHERE provider = $1 AND purpose = $2 AND subject = $3`,
    [provider, purpose, subject],
  )
  return res.rows[0]?.calls ?? 0
}

describe('reserve_external_call.pg', () => {
  it('increments the total and the purpose on an allowed call', async () => {
    const provider = freshProvider()
    expect(await reserve(provider, 'composer', 10, 100)).toMatchObject({ ok: true, total_calls: 1 })
    expect(await reserve(provider, 'refresh', 10, 100)).toMatchObject({ ok: true, total_calls: 2 })
    expect(await calls(provider, '_total')).toBe(2)
    expect(await calls(provider, 'composer')).toBe(1)
    expect(await calls(provider, 'refresh')).toBe(1)
  })

  it('refuses past the purpose cap and leaves every counter as it was', async () => {
    const provider = freshProvider()
    expect((await reserve(provider, 'composer', 2, 100)).ok).toBe(true)
    expect((await reserve(provider, 'composer', 2, 100)).ok).toBe(true)
    expect(await reserve(provider, 'composer', 2, 100)).toEqual({ ok: false, scope: 'purpose' })
    expect(await calls(provider, 'composer')).toBe(2)
    expect(await calls(provider, '_total')).toBe(2)
    // Another purpose still has room under the total.
    expect((await reserve(provider, 'refresh', 2, 100)).ok).toBe(true)
  })

  it('refuses past the total cap across purposes', async () => {
    const provider = freshProvider()
    expect((await reserve(provider, 'composer', null, 2)).ok).toBe(true)
    expect((await reserve(provider, 'refresh', null, 2)).ok).toBe(true)
    expect(await reserve(provider, 'mcp_lookup', null, 2)).toEqual({ ok: false, scope: 'total' })
    expect(await calls(provider, '_total')).toBe(2)
    expect(await calls(provider, 'mcp_lookup')).toBe(0)
    // A priority caller passing a larger total (the reserve) still gets through.
    expect((await reserve(provider, 'onboarding_lookup', null, 3)).ok).toBe(true)
  })

  it('caps one subject per day without touching another subject', async () => {
    const provider = freshProvider()
    expect((await reserve(provider, 'mcp_lookup', null, 100, 'key-a', 2)).ok).toBe(true)
    expect((await reserve(provider, 'mcp_lookup', null, 100, 'key-a', 2)).ok).toBe(true)
    expect(await reserve(provider, 'mcp_lookup', null, 100, 'key-a', 2)).toEqual({ ok: false, scope: 'subject' })
    expect(await subjectCalls(provider, 'mcp_lookup', 'key-a')).toBe(2)
    // The refused call was not charged to the purpose or the total either.
    expect(await calls(provider, 'mcp_lookup')).toBe(2)
    expect(await calls(provider, '_total')).toBe(2)
    expect((await reserve(provider, 'mcp_lookup', null, 100, 'key-b', 2)).ok).toBe(true)
  })

  it('grants exactly the cap under concurrency', async () => {
    const provider = freshProvider()
    const cap = 5
    const attempts = 20
    const results = await Promise.all(
      Array.from({ length: attempts }, async (_, i) => {
        const client = await getClient()
        try {
          const res = await client.query<{ r: Reservation }>(
            `SELECT public.reserve_external_call($1, $2::date, $3, NULL, $4) AS r`,
            [provider, CYCLE, i % 2 === 0 ? 'composer' : 'refresh', cap],
          )
          return res.rows[0]!.r
        } finally {
          client.release()
        }
      }),
    )
    expect(results.filter((r) => r.ok)).toHaveLength(cap)
    expect(results.filter((r) => !r.ok).every((r) => r.scope === 'total')).toBe(true)
    expect(await calls(provider, '_total')).toBe(cap)
    expect((await calls(provider, 'composer')) + (await calls(provider, 'refresh'))).toBe(cap)
  })

  it('refuses _total as a purpose', async () => {
    await expect(reserve(freshProvider(), '_total', null, 100)).rejects.toMatchObject({ code: '22023' })
  })

  it('runs for service_role and is closed to authenticated users', async () => {
    const provider = freshProvider()
    const viaService = await runAsServiceRole(async (client) => {
      const res = await client.query<{ r: Reservation }>(
        `SELECT public.reserve_external_call($1, $2::date, 'composer', NULL, 10) AS r`,
        [provider, CYCLE],
      )
      return res.rows[0]!.r
    })
    expect(viaService.ok).toBe(true)

    const userId = await insertAuthUser()
    await expect(
      withUserContext(userId, (client) =>
        client.query(`SELECT public.reserve_external_call($1, $2::date, 'composer', NULL, 10)`, [provider, CYCLE]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    for (const table of ['external_call_budget', 'external_call_subject_daily', 'external_call_cache']) {
      await expect(
        withUserContext(userId, (client) => client.query(`SELECT * FROM public.${table} LIMIT 1`)),
      ).rejects.toMatchObject({ code: '42501' })
    }
  })

  it('lets service_role use the response cache table', async () => {
    const key = randomUUID().replace(/-/g, '').padEnd(64, '0')
    await runAsServiceRole(async (client) => {
      await client.query(
        `INSERT INTO public.external_call_cache (provider, cache_key, response, expires_at)
         VALUES ('tic', $1, '{"found":1}'::jsonb, now() + interval '1 day')
         ON CONFLICT (provider, cache_key) DO UPDATE SET response = excluded.response`,
        [key],
      )
    })
    const res = await getPool().query<{ response: unknown }>(
      `SELECT response FROM public.external_call_cache WHERE provider = 'tic' AND cache_key = $1`,
      [key],
    )
    expect(res.rows[0]?.response).toEqual({ found: 1 })
    await getPool().query(`DELETE FROM public.external_call_cache WHERE cache_key = $1`, [key])
  })
})
