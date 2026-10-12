import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from '../../../../tests/pg/setup'
import { seedCompany, insertAuthUser, insertCompany } from '../../../../tests/pg/fixtures'
import { TRIAL_CAPABILITIES } from '../keys'

// pg-real coverage for migrations 20260628140000 (capability_grants /
// company_capability_config + RLS), 20260629120000
// (trial-grant trigger) and 20260925081321 (company_capability_grant_rows).
// Required by .claude/rules/database.md for any RPC/RLS/trigger change.
//
// The capability gate (lib/entitlements/has-capability.ts) reads grant rows
// through company_capability_grant_rows and decides expiry and enablement in
// TypeScript, so that function is what these tests assert through. (The SQL
// resolver company_has_capability had no caller and was dropped in
// 20261012100300.)
//
// NOTE: as of 20260629120000 an AFTER INSERT trigger auto-seeds a trial grant
// on the PAID keys for every new company. The entitlement tests therefore call
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

interface GrantRow {
  capability_key: string
  expires_at: Date | null
  source: string
  team_id: string | null
}

// Direct pool access carries no JWT role, so the tenant guard is bypassed the
// way it is for the service-role doors.
async function grantRows(companyId: string, keys: string[]): Promise<GrantRow[]> {
  const { rows } = await getPool().query<GrantRow>(
    `SELECT * FROM public.company_capability_grant_rows($1, $2::text[], false)
     ORDER BY capability_key, source`,
    [companyId, keys],
  )
  return rows
}

describe('company_capability_grant_rows (entitlement axis)', () => {
  it('returns nothing when no grant exists (fail-closed)', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    expect(await grantRows(companyId, ['ai'])).toEqual([])
  })

  it('returns an unexpired company-scoped grant with its expiry', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', expiresAt: future() })
    const rows = await grantRows(companyId, ['ai'])
    expect(rows).toEqual([expect.objectContaining({ capability_key: 'ai', source: 'manual', team_id: null })])
    expect(rows[0].expires_at!.getTime()).toBeGreaterThan(Date.now())
  })

  it('returns a null expiry as is (never-expiring)', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', source: 'comp', expiresAt: null })
    expect(await grantRows(companyId, ['ai'])).toEqual([
      expect.objectContaining({ capability_key: 'ai', source: 'comp', expires_at: null }),
    ])
  })

  it('returns an expired grant too, for the caller to judge', async () => {
    const { companyId } = await seedCompany()
    await clearGrants(companyId)
    await insertGrant({ companyId, key: 'ai', source: 'trial', expiresAt: past() })
    const rows = await grantRows(companyId, ['ai'])
    expect(rows).toHaveLength(1)
    expect(rows[0].expires_at!.getTime()).toBeLessThan(Date.now())
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
    expect(await grantRows(companyId, ['skatteverket'])).toEqual([
      expect.objectContaining({ capability_key: 'skatteverket', team_id: teamId }),
    ])
  })
})

describe('company_capability_config (enablement axis)', () => {
  it("shows a member the company's explicit disable, which the gate reads on the user's client", async () => {
    const { userId, companyId } = await seedCompany()
    await getPool().query(
      `INSERT INTO public.company_capability_config (company_id, capability_key, enabled)
       VALUES ($1, 'ai', false)`,
      [companyId],
    )
    const rows = await withUserContext(userId, async (client) => {
      const r = await client.query<{ enabled: boolean }>(
        `SELECT enabled FROM public.company_capability_config WHERE company_id = $1 AND capability_key = 'ai'`,
        [companyId],
      )
      return r.rows
    })
    expect(rows).toEqual([{ enabled: false }])
  })
})

describe('company_capability_grant_rows for a member', () => {
  it('returns the auto-seeded trial row to a member under authenticated ctx', async () => {
    const { userId, companyId } = await seedCompany()
    const rows = await withUserContext(userId, async (client) => {
      const r = await client.query<{ capability_key: string; source: string }>(
        `SELECT capability_key, source FROM public.company_capability_grant_rows($1, ARRAY['ai'], false)`,
        [companyId],
      )
      return r.rows
    })
    expect(rows).toEqual([{ capability_key: 'ai', source: 'trial' }])
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
    // Every trial key, compared against the constant itself so the trigger's
    // hardcoded list (20260629120000, widened 20260818170000) can never drift
    // from TRIAL_CAPABILITIES (PAID_CAPABILITIES minus the paid-plan-only
    // keys) again without this test failing.
    expect(rows.map((r) => r.capability_key)).toEqual([...TRIAL_CAPABILITIES].sort())
    expect(rows.every((r) => r.source === 'trial')).toBe(true)
    expect(rows.every((r) => r.expires_at !== null)).toBe(true)
    // ...and the gate's read returns it as live.
    const ai = await grantRows(companyId, ['ai'])
    expect(ai).toEqual([expect.objectContaining({ capability_key: 'ai', source: 'trial', team_id: null })])
    expect(ai[0].expires_at!.getTime()).toBeGreaterThan(Date.now())
  })

  it('does not seed free keys (only the PAID set is granted)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    expect(await grantRows(companyId, ['cloud_backup', 'org_lookup'])).toEqual([])
  })
})

// Migration 20260925081321: the capability gate reads its grant rows through
// company_capability_grant_rows, because the SELECT policy above hides a
// team's rows from a client company's users who are not on the team.
describe('company_capability_grant_rows', () => {
  async function byraClient(): Promise<{ userId: string; companyId: string; teamId: string }> {
    const { userId, companyId } = await seedCompany()
    await clearGrants(companyId)
    const firmOwner = await insertAuthUser()
    const teamId = randomUUID()
    await getPool().query(
      `INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Firm', $2)`,
      [teamId, firmOwner],
    )
    await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [teamId, companyId])
    // The client company's user is a company member only, never a team member.
    await getPool().query(`DELETE FROM public.team_members WHERE team_id = $1 AND user_id = $2`, [
      teamId,
      userId,
    ])
    await getPool().query(`DELETE FROM public.capability_grants WHERE team_id = $1`, [teamId])
    return { userId, companyId, teamId }
  }

  it("returns the team's grant to a company member outside the team, which the RLS read hides", async () => {
    const { userId, companyId, teamId } = await byraClient()
    await insertGrant({ teamId, key: 'ai', expiresAt: null })

    const { direct, viaRpc } = await withUserContext(userId, async (client) => {
      const d = await client.query(`SELECT id FROM public.capability_grants WHERE team_id = $1`, [teamId])
      const r = await client.query<{ capability_key: string; team_id: string; source: string }>(
        `SELECT * FROM public.company_capability_grant_rows($1, ARRAY['ai'], false)`,
        [companyId],
      )
      return { direct: d.rowCount, viaRpc: r.rows }
    })
    expect(direct).toBe(0)
    expect(viaRpc).toEqual([
      expect.objectContaining({ capability_key: 'ai', team_id: teamId, source: 'manual' }),
    ])
  })

  it('returns company and team rows, narrowed to the requested keys', async () => {
    const { userId, companyId, teamId } = await byraClient()
    await insertGrant({ companyId, key: 'ai', source: 'trial', expiresAt: future() })
    await insertGrant({ teamId, key: 'bank_sync', expiresAt: null })
    await insertGrant({ teamId, key: 'skatteverket', expiresAt: past() })

    const keys = await withUserContext(userId, async (client) => {
      const r = await client.query<{ capability_key: string }>(
        `SELECT capability_key FROM public.company_capability_grant_rows($1, ARRAY['ai', 'skatteverket'], false)
         ORDER BY capability_key`,
        [companyId],
      )
      return r.rows.map((row) => row.capability_key)
    })
    // Expired rows come back too: the caller derives trial and grace state from them.
    expect(keys).toEqual(['ai', 'skatteverket'])
  })

  it('returns only connector-sourced rows when p_connector_only is set', async () => {
    const { companyId } = await byraClient()
    await insertGrant({ companyId, key: 'bank_sync', source: 'trial', expiresAt: future() })
    await insertGrant({ companyId, key: 'bank_sync', source: 'connector', expiresAt: future() })

    const { rows } = await getPool().query<{ source: string }>(
      `SELECT source FROM public.company_capability_grant_rows($1, ARRAY['bank_sync'], true)`,
      [companyId],
    )
    expect(rows.map((r) => r.source)).toEqual(['connector'])
  })

  it('raises 42501 when a non-member asks about a company (authenticated ctx)', async () => {
    const { companyId } = await byraClient()
    const outsider = await insertAuthUser()
    await expect(
      withUserContext(outsider, async (client) => {
        await client.query(`SELECT * FROM public.company_capability_grant_rows($1, ARRAY['ai'], false)`, [
          companyId,
        ])
      }),
    ).rejects.toThrow(/unauthorized/)
  })
})
