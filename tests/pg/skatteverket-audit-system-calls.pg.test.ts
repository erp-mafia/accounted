/**
 * skatteverket_api_audit_log.user_id is nullable (migration
 * 20261003124517): the transport now writes one row per outbound call, and a
 * background read on Accounted's own ombud credentials has no user behind it.
 * NULL records exactly that. The row stays immutable, stays readable to the
 * company's members, and still counts for the reset guards, which read
 * endpoint and outcome only.
 */
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany } from './fixtures'

async function insertSystemCall(companyId: string, endpoint: string, redovisningsperiod: string | null = null) {
  const { rows } = await getPool().query<{ id: string; user_id: string | null }>(
    `INSERT INTO public.skatteverket_api_audit_log
       (company_id, user_id, endpoint, redovisningsperiod, outcome, response_status)
     VALUES ($1, NULL, $2, $3, 'ok', 200)
     RETURNING id, user_id`,
    [companyId, endpoint, redovisningsperiod],
  )
  return rows[0]!
}

async function resetBlockers(userId: string, companyId: string) {
  return withUserContext(userId, async (client) => {
    const { rows } = await client.query<{
      result: { eligibility?: { blockers: Array<{ code: string; count: number }> } }
    }>(`SELECT public.get_company_migration_reset_eligibility($1) AS result`, [companyId])
    return rows[0]!.result.eligibility?.blockers ?? []
  })
}

describe('skatteverket_api_audit_log: system calls with no user (pg)', () => {
  it('accepts a row with a null user_id', async () => {
    const { companyId } = await seedCompany()
    const row = await insertSystemCall(companyId, 'kvittenser', '202606')
    expect(row.user_id).toBeNull()
  })

  it('keeps a system-call row immutable', async () => {
    const { companyId } = await seedCompany()
    const row = await insertSystemCall(companyId, 'inlamnat', '202606')
    await expect(
      getPool().query(`UPDATE public.skatteverket_api_audit_log SET outcome = 'skv_error' WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/cannot be modified or deleted/)
    await expect(
      getPool().query(`DELETE FROM public.skatteverket_api_audit_log WHERE id = $1`, [row.id]),
    ).rejects.toThrow(/cannot be modified or deleted/)
  })

  it('lets the company members read a system-call row through RLS', async () => {
    const { companyId, userId } = await seedCompany()
    const row = await insertSystemCall(companyId, 'skattekonto/saldo')
    const seen = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM public.skatteverket_api_audit_log WHERE id = $1`,
        [row.id],
      )
      return rows
    })
    expect(seen).toEqual([{ id: row.id }])
  })

  it.each(['agi/submit', 'declaration/submit'])(
    'a %s ok row with no user still blocks the migration reset',
    async (endpoint) => {
      const { companyId, userId } = await seedCompany()
      await insertSystemCall(companyId, endpoint)
      expect(await resetBlockers(userId, companyId)).toContainEqual({
        code: 'authority_submission_detected',
        count: 1,
      })
    },
  )

  it('a non-guard label with no user does not block the migration reset', async () => {
    const { companyId, userId } = await seedCompany()
    await insertSystemCall(companyId, 'kvittenser', '202606')
    const blockers = await resetBlockers(userId, companyId)
    expect(blockers.map((b) => b.code)).not.toContain('authority_submission_detected')
  })
})
