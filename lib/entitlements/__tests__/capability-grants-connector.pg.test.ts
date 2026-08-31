import { describe, it, expect } from 'vitest'
import { getPool } from '../../../tests/pg/setup'
import { seedCompany } from '../../../tests/pg/fixtures'
import { CONNECTOR_CAPABILITIES, PAID_CAPABILITIES } from '../keys'

// pg-real coverage for migration 20260831170000 (capability_grants.source
// accepts 'connector') and the invariant that the trial-seed trigger never
// hands a hosted company a connector grant.

const future = () => new Date(Date.now() + 86_400_000).toISOString()

async function clearGrants(companyId: string): Promise<void> {
  await getPool().query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [companyId])
}

async function rpc(companyId: string, key: string): Promise<boolean> {
  const { rows } = await getPool().query<{ ok: boolean }>(
    `SELECT public.company_has_capability($1, $2) AS ok`,
    [companyId, key],
  )
  return rows[0].ok
}

describe('capability_grants.source = connector', () => {
  it('accepts connector and still rejects an unknown source', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await getPool().query(
      `INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
       VALUES ($1, 'bank_sync', 'connector', $2)`,
      [companyId, future()],
    )
    expect(await rpc(companyId, 'bank_sync')).toBe(true)

    await expect(
      getPool().query(
        `INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
         VALUES ($1, 'bank_sync', 'bogus', $2)`,
        [companyId, future()],
      ),
    ).rejects.toThrow(/capability_grants_source_check/)
  })

  it('upserts on the (scope, key, source) identity like the stripe writer does', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    const first = future()
    const later = new Date(Date.now() + 2 * 86_400_000).toISOString()
    for (const exp of [first, later]) {
      await getPool().query(
        `INSERT INTO public.capability_grants (company_id, team_id, capability_key, source, expires_at)
         VALUES ($1, NULL, 'skatteverket', 'connector', $2)
         ON CONFLICT (company_id, team_id, capability_key, source) DO UPDATE SET expires_at = EXCLUDED.expires_at`,
        [companyId, exp],
      )
    }
    const { rows } = await getPool().query<{ n: string; expires_at: Date }>(
      `SELECT count(*)::text AS n, max(expires_at) AS expires_at FROM public.capability_grants
        WHERE company_id = $1 AND capability_key = 'skatteverket' AND source = 'connector'`,
      [companyId],
    )
    expect(rows[0].n).toBe('1')
    expect(new Date(rows[0].expires_at).toISOString()).toBe(later)
  })

  // Hosted companies must never be handed connector grants: the trial seed
  // covers the PAID keys only, and the connector-only keys get nothing.
  it('the trial-seed trigger writes no connector-source rows and nothing for connector-only keys', async () => {
    const { companyId } = await seedCompany()
    const { rows } = await getPool().query<{ capability_key: string; source: string }>(
      `SELECT capability_key, source FROM public.capability_grants WHERE company_id = $1`,
      [companyId],
    )
    expect(rows.some((r) => r.source === 'connector')).toBe(false)
    const connectorOnly = CONNECTOR_CAPABILITIES.filter((k) => !PAID_CAPABILITIES.includes(k))
    expect(connectorOnly.length).toBeGreaterThan(0)
    for (const key of connectorOnly) {
      expect(rows.some((r) => r.capability_key === key), `no trial grant for ${key}`).toBe(false)
    }
  })
})
