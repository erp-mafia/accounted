/**
 * The bulk entitlement read against a REAL PostgREST, for a deleted company.
 *
 * getCompanyIdsWithCapability is the work list of the bank-sync, Open Payments
 * and skattekonto crons. A deleted company is only companies.archived_at, and
 * the grants that cover it outlive the delete: the 30-day trial the insert
 * trigger seeds, a company grant, a byrå team grant that never expires. A
 * mocked client cannot show that the archived filter reaches PostgREST and
 * keeps those companies out (accounted#198).
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { insertAuthUser, insertCompany, insertCompanyMember } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from '@/tests/tool-pg/client'
import { getCompanyIdsWithCapability } from '../has-capability'
import { CAPABILITY } from '../keys'

async function company(): Promise<string> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId })
  return companyId
}

async function setArchived(companyId: string, archived: boolean): Promise<void> {
  await getPool().query(`UPDATE public.companies SET archived_at = $2 WHERE id = $1`, [
    companyId,
    archived ? new Date().toISOString() : null,
  ])
}

async function onlyGrant(companyId: string, key: string): Promise<void> {
  await getPool().query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [companyId])
  await getPool().query(
    `INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
     VALUES ($1, $2, 'manual', NULL)`,
    [companyId, key],
  )
}

async function byraTeam(key: string): Promise<string> {
  const owner = await insertAuthUser()
  const teamId = randomUUID()
  await getPool().query(`INSERT INTO public.teams (id, name, created_by) VALUES ($1, 'Byrå', $2)`, [teamId, owner])
  await getPool().query(`DELETE FROM public.capability_grants WHERE team_id = $1`, [teamId])
  await getPool().query(
    `INSERT INTO public.capability_grants (team_id, capability_key, source, expires_at)
     VALUES ($1, $2, 'manual', NULL)`,
    [teamId, key],
  )
  return teamId
}

async function clientOf(teamId: string): Promise<string> {
  const companyId = await company()
  // Only the team grant covers it.
  await getPool().query(`DELETE FROM public.capability_grants WHERE company_id = $1`, [companyId])
  await getPool().query(`UPDATE public.companies SET team_id = $1 WHERE id = $2`, [teamId, companyId])
  return companyId
}

describe('getCompanyIdsWithCapability for a deleted company (real PostgREST)', () => {
  it('leaves out a deleted company covered by its trial, its own grant or a byrå team grant', async () => {
    const supabase = createToolPgClient()
    const teamId = await byraTeam(CAPABILITY.bank_sync)

    const liveTrial = await company()
    const liveOwn = await company()
    await onlyGrant(liveOwn, CAPABILITY.bank_sync)
    const liveClient = await clientOf(teamId)

    const deletedTrial = await company()
    const deletedOwn = await company()
    await onlyGrant(deletedOwn, CAPABILITY.bank_sync)
    const deletedClient = await clientOf(teamId)
    for (const id of [deletedTrial, deletedOwn, deletedClient]) await setArchived(id, true)

    const asked = [liveTrial, liveOwn, liveClient, deletedTrial, deletedOwn, deletedClient]
    const entitled = await getCompanyIdsWithCapability(supabase, asked, CAPABILITY.bank_sync)

    expect([...entitled].sort()).toEqual([liveTrial, liveOwn, liveClient].sort())
  })

  it('answers the skattekonto key the same way, and a restored company is entitled again', async () => {
    const supabase = createToolPgClient()
    const live = await company()
    const deleted = await company()
    await setArchived(deleted, true)

    expect(await getCompanyIdsWithCapability(supabase, [live, deleted], CAPABILITY.skatteverket)).toEqual(
      new Set([live]),
    )

    await setArchived(deleted, false)
    expect(await getCompanyIdsWithCapability(supabase, [live, deleted], CAPABILITY.skatteverket)).toEqual(
      new Set([live, deleted]),
    )
  })
})
