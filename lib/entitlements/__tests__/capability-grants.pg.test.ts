import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from '../../../tests/pg/setup'
import { seedCompany, insertAuthUser, insertCompany } from '../../../tests/pg/fixtures'
import { PAID_CAPABILITIES } from '../keys'

// pg-real coverage for migrations 20260628140000 (capability_grants /
// company_capability_config / metered_events + company_has_capability RPC +
// RLS) and 20260629120000 (trial-grant trigger). Required by
// .claude/rules/database.md for any RPC/RLS/trigger change.
//
// NOTE: as of 20260629120000 an AFTER INSERT trigger auto-seeds a trial grant
// on the PAID keys for every new company. The resolver tests therefore call
// clearGrants() first to assert against a controlled grant state.

const future = () => new Date(Date.now() + 86_400_000).toISOString()
const past = () => new Date(Date.now() - 86_400_000).toISOString()

async function insertGrant(p: {
  companyId?: string | null
  teamId?: string | null
  key: string
  source?: string
  expiresAt?: string | null
}): Promise<void> {
  await getPool().query(
    `INSERT INTO public.capability_grants (company_id, team_id, capability_key, source, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [p.companyId ?? null, p.teamId ?? null, p.key, p.source ?? 'manual', p.expiresAt ?? null],
  )
}

// Remove the trigger-seeded trial grants so a test can assert a controlled state.
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

describe('company_has_capability (entitlement axis)', () => {
  it('is false when no grant exists (fail-closed)', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    expect(await rpc(companyId, 'ai')).toBe(false)
  })

  it('is true for an unexpired company-scoped grant', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', expiresAt: future() })
    expect(await rpc(companyId, 'ai')).toBe(true)
  })

  it('treats a null expiry as never-expiring', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', source: 'comp', expiresAt: null })
    expect(await rpc(companyId, 'ai')).toBe(true)
  })

  it('is false once the grant has expired', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', source: 'trial', expiresAt: past() })
    expect(await rpc(companyId, 'ai')).toBe(false)
  })

  it('cascades a firm/team-scoped grant to the client company', async () => {
    const { userId, companyId } = await seedCompany()
    await clearGrants(companyId)
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Firm', $2)`,
      [teamId, userId],
    )
    await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [
      teamId,
      companyId,
    ])
    await insertGrant({ teamId, key: 'skatteverket', expiresAt: future() })
    expect(await rpc(companyId, 'skatteverket')).toBe(true)
  })
})

describe('company_has_capability (enablement axis)', () => {
  it('is false when entitled but explicitly disabled', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', expiresAt: null })
    await getPool().query(
      `INSERT INTO public.company_capability_config (company_id, capability_key, enabled)
       VALUES ($1, 'ai', false)`,
      [companyId],
    )
    expect(await rpc(companyId, 'ai')).toBe(false)
  })
})

describe('company_has_capability tenant guard', () => {
  it('raises 42501 when a non-member asks about a company (authenticated ctx)', async () => {
    const { companyId } = await seedCompany()
    const outsider = await insertAuthUser()
    await expect(
      withUserContext(outsider, async (client) => {
        await client.query(`SELECT public.company_has_capability($1, 'ai')`, [companyId])
      }),
    ).rejects.toThrow(/unauthorized/)
  })

  it('lets a member resolve their own company under authenticated ctx', async () => {
    const { userId, companyId } = await seedCompany()
    const ok = await withUserContext(userId, async (client) => {
      const r = await client.query<{ ok: boolean }>(
        `SELECT public.company_has_capability($1, 'ai') AS ok`,
        [companyId],
      )
      return r.rows[0].ok
    })
    // entitled via the auto-seeded trial grant
    expect(ok).toBe(true)
  })
})

describe('capability_grants RLS', () => {
  it('lets a member read their own grants but hides them from non-members', async () => {
    const { userId, companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', expiresAt: null })

    const memberCount = await withUserContext(userId, async (client) => {
      const r = await client.query(
        `SELECT id FROM public.capability_grants WHERE company_id = $1`,
        [companyId],
      )
      return r.rowCount
    })
    expect(memberCount).toBe(1)

    const outsider = await insertAuthUser()
    const outsiderCount = await withUserContext(outsider, async (client) => {
      const r = await client.query(
        `SELECT id FROM public.capability_grants WHERE company_id = $1`,
        [companyId],
      )
      return r.rowCount
    })
    expect(outsiderCount).toBe(0)
  })

  it('forbids a member from self-granting an entitlement (no INSERT policy)', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(
      withUserContext(userId, async (client) => {
        await client.query(
          `INSERT INTO public.capability_grants (company_id, capability_key, source)
           VALUES ($1, 'ai', 'manual')`,
          [companyId],
        )
      }),
    ).rejects.toThrow()
  })
})

describe('capability_grants scope constraint', () => {
  it('rejects a grant with neither company_id nor team_id', async () => {
    await expect(
      getPool().query(
        `INSERT INTO public.capability_grants (capability_key, source) VALUES ('ai', 'manual')`,
      ),
    ).rejects.toThrow()
  })

  it('rejects a grant with both company_id and team_id', async () => {
    const { userId, companyId } = await seedCompany()
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Firm', $2)`,
      [teamId, userId],
    )
    await expect(insertGrant({ companyId, teamId, key: 'ai' })).rejects.toThrow()
  })
})

describe('trial grant seeding trigger (20260629120000, widened 20260818170000)', () => {
  it('grants a new company a 30-day trial on the PAID keys at creation', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const { rows } = await getPool().query<{
      capability_key: string
      source: string
      expires_at: string | null
    }>(
      `SELECT capability_key, source, expires_at FROM public.capability_grants
       WHERE company_id = $1 ORDER BY capability_key`,
      [companyId],
    )
    // Every PAID key, compared against the constant itself so the trigger's
    // hardcoded list (20260629120000, widened 20260818170000) can never drift
    // from PAID_CAPABILITIES again without this test failing.
    expect(rows.map((r) => r.capability_key)).toEqual([...PAID_CAPABILITIES].sort())
    expect(rows.every((r) => r.source === 'trial')).toBe(true)
    expect(rows.every((r) => r.expires_at !== null)).toBe(true)
    expect(await rpc(companyId, 'ai')).toBe(true)
  })

  it('does not seed free keys (only the PAID set is granted)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    expect(await rpc(companyId, 'cloud_backup')).toBe(false)
    expect(await rpc(companyId, 'org_lookup')).toBe(false)
  })
})
