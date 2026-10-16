import { beforeEach, describe, expect, it } from 'vitest'
import { getPool, runAsServiceRole, withUserContext } from './setup'
import { seedCompany, setActiveCompany } from './fixtures'

/**
 * Suggestions (migration 20261016200600): stage_company_suggestion stages one
 * pending operation per company and key while it is open, as the system,
 * and respects the company's answers, which sync_company_suggestion_decision
 * reads off every door's decision on the pending operation: committed is
 * accepted, a rejection with the reason "Visa aldrig" is declined for good,
 * any other rejection (Inte nu, the expiry, a refused approval) snoozes the
 * key for 30 days. An operation type the database does not know yet raises
 * check_violation and writes nothing (the deploy-order safety the caller
 * relies on).
 */

const KEY = 'enable_package:payroll'

interface StageResult {
  staged: boolean
  reason?: string
  suggestion_id?: string
  pending_operation_id?: string
}

async function stage(companyId: string, userId: string, opts: { key?: string; operationType?: string } = {}): Promise<StageResult> {
  return runAsServiceRole(async (client) => {
    const { rows } = await client.query<{ result: StageResult }>(
      `SELECT public.stage_company_suggestion($1, $2, $3, 'first-employee', 30, $4, 'Slå på Lön?',
                                              $5::jsonb, $6::jsonb, 'low') AS result`,
      [
        companyId,
        userId,
        opts.key ?? KEY,
        opts.operationType ?? 'enable_package',
        JSON.stringify({ package_id: 'payroll', source: 'suggestion' }),
        JSON.stringify({ package: 'Lön', reason: 'Du har registrerat en anställd.' }),
      ],
    )
    return rows[0].result
  })
}

async function suggestion(companyId: string, key = KEY) {
  const { rows } = await getPool().query(
    `SELECT state, rank, pending_operation_id, snoozed_until, decided_at
       FROM public.company_suggestions WHERE company_id = $1 AND suggestion_key = $2`,
    [companyId, key],
  )
  return rows[0] ?? null
}

async function reject(operationId: string, reason: string | null, category = 'other') {
  await getPool().query(
    `UPDATE public.pending_operations
        SET status = 'rejected', resolved_at = now(), rejection_category = $2, rejection_reason = $3
      WHERE id = $1`,
    [operationId, category, reason],
  )
}

async function pendingCount(companyId: string): Promise<number> {
  const { rows } = await getPool().query<{ n: number }>(
    `SELECT count(*)::int AS n FROM public.pending_operations WHERE company_id = $1 AND status = 'pending'`,
    [companyId],
  )
  return rows[0].n
}

describe('stage_company_suggestion and the decision trigger', () => {
  let userId: string
  let companyId: string

  beforeEach(async () => {
    const seeded = await seedCompany()
    userId = seeded.userId
    companyId = seeded.companyId
  })

  it('stages a pending operation as the system and marks the key open', async () => {
    const result = await stage(companyId, userId)
    expect(result.staged).toBe(true)
    const { rows } = await getPool().query(
      `SELECT operation_type, status, actor_type, actor_label, risk_level, title, params, preview_data, user_id
         FROM public.pending_operations WHERE id = $1`,
      [result.pending_operation_id],
    )
    expect(rows[0]).toMatchObject({
      operation_type: 'enable_package',
      status: 'pending',
      actor_type: 'system',
      actor_label: 'Accounted',
      risk_level: 'low',
      title: 'Slå på Lön?',
      user_id: userId,
    })
    expect(rows[0].params).toEqual({ package_id: 'payroll', source: 'suggestion', suggestion_key: KEY })
    expect(await suggestion(companyId)).toMatchObject({ state: 'open', rank: 30, pending_operation_id: result.pending_operation_id })
  })

  it('never stages the same suggestion twice while it is open', async () => {
    const first = await stage(companyId, userId)
    const second = await stage(companyId, userId)
    expect(second).toMatchObject({ staged: false, reason: 'open', pending_operation_id: first.pending_operation_id })
    expect(await pendingCount(companyId)).toBe(1)
  })

  it('stages it once when two stagers race', async () => {
    const results = await Promise.all([stage(companyId, userId), stage(companyId, userId), stage(companyId, userId)])
    expect(results.filter((r) => r.staged)).toHaveLength(1)
    expect(await pendingCount(companyId)).toBe(1)
  })

  it('"Inte nu" snoozes the key for 30 days, after which it may be proposed again', async () => {
    const first = await stage(companyId, userId)
    await reject(first.pending_operation_id!, 'Inte nu')
    const snoozed = await suggestion(companyId)
    expect(snoozed.state).toBe('snoozed')
    const days = (new Date(snoozed.snoozed_until).getTime() - Date.now()) / 86_400_000
    expect(days).toBeGreaterThan(29.9)
    expect(days).toBeLessThan(30.1)
    expect(await stage(companyId, userId)).toMatchObject({ staged: false, reason: 'snoozed' })

    await getPool().query(
      `UPDATE public.company_suggestions SET snoozed_until = now() - interval '1 second' WHERE company_id = $1`,
      [companyId],
    )
    const again = await stage(companyId, userId)
    expect(again.staged).toBe(true)
    expect(await suggestion(companyId)).toMatchObject({ state: 'open', snoozed_until: null, pending_operation_id: again.pending_operation_id })
  })

  it('a plain rejection, the expiry and a refused approval snooze it too', async () => {
    const first = await stage(companyId, userId)
    await reject(first.pending_operation_id!, null)
    expect((await suggestion(companyId)).state).toBe('snoozed')

    const other = await stage(companyId, userId, { key: 'enable_package:pos-and-webshop' })
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'rejected', resolved_at = now(), rejection_category = 'expired',
              result_data = '{"auto_rejected": true, "reason": "expired"}' WHERE id = $1`,
      [other.pending_operation_id],
    )
    expect((await suggestion(companyId, 'enable_package:pos-and-webshop')).state).toBe('snoozed')
  })

  it('"Visa aldrig" declines it for good', async () => {
    const first = await stage(companyId, userId)
    await reject(first.pending_operation_id!, '  visa ALDRIG ')
    expect(await suggestion(companyId)).toMatchObject({ state: 'declined', snoozed_until: null })
    expect(await stage(companyId, userId)).toMatchObject({ staged: false, reason: 'declined' })

    const english = await stage(companyId, userId, { key: 'enable_package:assets' })
    await reject(english.pending_operation_id!, 'never')
    expect((await suggestion(companyId, 'enable_package:assets')).state).toBe('declined')
  })

  it('an approval accepts it; the condition decides whether it comes back', async () => {
    const first = await stage(companyId, userId)
    await getPool().query(`UPDATE public.pending_operations SET status = 'committing' WHERE id = $1`, [first.pending_operation_id])
    expect((await suggestion(companyId)).state).toBe('open')
    await getPool().query(
      `UPDATE public.pending_operations SET status = 'committed', resolved_at = now() WHERE id = $1`,
      [first.pending_operation_id],
    )
    expect((await suggestion(companyId)).state).toBe('accepted')
    expect((await stage(companyId, userId)).staged).toBe(true)
  })

  it('an approval handed back to pending leaves it open', async () => {
    const first = await stage(companyId, userId)
    await getPool().query(`UPDATE public.pending_operations SET status = 'committing' WHERE id = $1`, [first.pending_operation_id])
    await getPool().query(`UPDATE public.pending_operations SET status = 'pending' WHERE id = $1`, [first.pending_operation_id])
    expect((await suggestion(companyId)).state).toBe('open')
    expect(await stage(companyId, userId)).toMatchObject({ staged: false, reason: 'open' })
  })

  it('writes nothing when the database does not know the operation type (check_violation)', async () => {
    await expect(stage(companyId, userId, { key: 'apply_profile:retail', operationType: 'apply_profile' })).rejects.toMatchObject({
      code: '23514',
    })
    expect(await suggestion(companyId, 'apply_profile:retail')).toBeNull()
    expect(await pendingCount(companyId)).toBe(0)
  })

  it('lets members read their own company\'s suggestions only, and stage none', async () => {
    await stage(companyId, userId)
    const other = await seedCompany()
    await stage(other.companyId, other.userId)
    await setActiveCompany(userId, companyId)

    const seen = await withUserContext(userId, async (client) => {
      const { rows } = await client.query<{ company_id: string }>(`SELECT company_id FROM public.company_suggestions`)
      return rows.map((r) => r.company_id)
    })
    expect(seen).toEqual([companyId])

    await expect(
      withUserContext(userId, (client) =>
        client.query(
          `SELECT public.stage_company_suggestion($1, $2, 'enable_package:bank', 'x', 0, 'enable_package', 't', '{}', '{}', 'low')`,
          [companyId, userId],
        ),
      ),
    ).rejects.toMatchObject({ code: '42501' })
    await expect(
      withUserContext(userId, (client) =>
        client.query(`UPDATE public.company_suggestions SET state = 'declined' WHERE company_id = $1`, [companyId]),
      ),
    ).rejects.toMatchObject({ code: '42501' })
  })
})
