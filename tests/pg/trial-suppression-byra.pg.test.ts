import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

// Tests for 20260826130300_suppress_trial_for_byra_companies.sql (WL-10):
// the company-creation trial trigger (trg_seed_trial_capability_grants /
// seed_trial_capability_grants) must skip companies attached to a byrå team
// (already entitled via the team-scoped partner grant) while personal-team
// and teamless companies keep the 30-day trial exactly as before.
//
// The trigger is AFTER INSERT ON companies and reads NEW.team_id, so plain
// inserts through the pool exercise it on every creation path.

const TRIAL_KEYS = ['ai', 'bank_sync', 'email_send', 'skatteverket']

async function insertTeam(params: {
  createdBy: string
  kind: 'personal' | 'byra'
  name?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.teams (id, name, created_by, kind)
     VALUES ($1, $2, $3, $4)`,
    [id, params.name ?? 'Trial Test Team', params.createdBy, params.kind],
  )
  await getPool().query(
    `INSERT INTO public.team_members (team_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [id, params.createdBy],
  )
  return id
}

async function insertCompanyOnTeam(params: {
  createdBy: string
  teamId: string | null
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.companies (id, name, entity_type, created_by, team_id)
     VALUES ($1, 'Trial Test AB', 'aktiebolag', $2, $3)`,
    [id, params.createdBy, params.teamId],
  )
  return id
}

async function trialGrantKeys(companyId: string): Promise<string[]> {
  const { rows } = await getPool().query<{ capability_key: string }>(
    `SELECT capability_key FROM public.capability_grants
     WHERE company_id = $1 AND source = 'trial'
     ORDER BY capability_key`,
    [companyId],
  )
  return rows.map((r) => r.capability_key)
}

describe('trial suppression for byrå-team companies', () => {
  it('a company created under a byrå team gets NO trial grants', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })

    const companyId = await insertCompanyOnTeam({ createdBy: byraOwner, teamId: byraTeam })

    expect(await trialGrantKeys(companyId)).toEqual([])
  })

  it('a company created under a personal team still gets the full trial', async () => {
    const user = await insertAuthUser()
    const personalTeam = await insertTeam({ createdBy: user, kind: 'personal' })

    const companyId = await insertCompanyOnTeam({ createdBy: user, teamId: personalTeam })

    expect(await trialGrantKeys(companyId)).toEqual(TRIAL_KEYS)
  })

  it('a teamless company still gets the full trial', async () => {
    const user = await insertAuthUser()

    const companyId = await insertCompanyOnTeam({ createdBy: user, teamId: null })

    expect(await trialGrantKeys(companyId)).toEqual(TRIAL_KEYS)
  })

  it('personal-team trial expiry stays created_at + 30 days', async () => {
    const user = await insertAuthUser()
    const personalTeam = await insertTeam({ createdBy: user, kind: 'personal' })
    const companyId = await insertCompanyOnTeam({ createdBy: user, teamId: personalTeam })

    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT bool_and(g.expires_at = c.created_at + interval '30 days') AS ok
       FROM public.capability_grants g
       JOIN public.companies c ON c.id = g.company_id
       WHERE g.company_id = $1 AND g.source = 'trial'`,
      [companyId],
    )
    expect(rows[0]!.ok).toBe(true)
  })

  it('byrå suppression does not block non-trial grants on the same company', async () => {
    const byraOwner = await insertAuthUser()
    const byraTeam = await insertTeam({ createdBy: byraOwner, kind: 'byra' })
    const companyId = await insertCompanyOnTeam({ createdBy: byraOwner, teamId: byraTeam })

    // The team-scoped partner grant (WL-10 v1 mechanics) is unaffected.
    await getPool().query(
      `INSERT INTO public.capability_grants (team_id, capability_key, source, expires_at)
       VALUES ($1, 'ai', 'manual', NULL)`,
      [byraTeam],
    )

    const { rows } = await getPool().query<{ ok: boolean }>(
      `SELECT public.company_has_capability($1, 'ai') AS ok`,
      [companyId],
    )
    expect(rows[0]!.ok).toBe(true)
  })
})
