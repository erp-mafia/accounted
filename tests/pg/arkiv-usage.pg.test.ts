import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, seedCompany } from './fixtures'

/**
 * Arkiv phase 9e. The meter accumulates per company, day and activity,
 * members read their own company only, and nobody but the service adds.
 */
describe('arkiv_usage_daily', () => {
  it('accumulates through arkiv_usage_add, is read by members only, and rejects an unknown activity', async () => {
    const { userId, companyId } = await seedCompany()
    const stranger = await insertAuthUser()
    await getPool().query(`SELECT public.arkiv_usage_add($1, 'pages_read', 3, '2026-09-17')`, [companyId])
    await getPool().query(`SELECT public.arkiv_usage_add($1, 'pages_read', 4, '2026-09-17')`, [companyId])
    await getPool().query(`SELECT public.arkiv_usage_add($1, 'documents', 1, '2026-09-16')`, [companyId])
    await getPool().query(`SELECT public.arkiv_usage_add($1, 'asks', -5, '2026-09-17')`, [companyId])
    await expect(getPool().query(`SELECT public.arkiv_usage_add($1, 'coffee', 1, '2026-09-17')`, [companyId])).rejects.toThrow(/arkiv_usage_daily_activity_check/)

    const mine = await withUserContext(userId, async (client) => (await client.query(`SELECT day::text, activity, units FROM public.arkiv_usage_daily WHERE company_id = $1 ORDER BY day, activity`, [companyId])).rows)
    expect(mine).toEqual([
      { day: '2026-09-16', activity: 'documents', units: 1 },
      { day: '2026-09-17', activity: 'asks', units: 0 },
      { day: '2026-09-17', activity: 'pages_read', units: 7 },
    ])
    const theirs = await withUserContext(stranger, async (client) => (await client.query(`SELECT units FROM public.arkiv_usage_daily WHERE company_id = $1`, [companyId])).rows)
    expect(theirs).toEqual([])
    // A member cannot add to the meter, neither directly nor through the function.
    const written = await withUserContext(userId, (client) => client.query(`UPDATE public.arkiv_usage_daily SET units = 999 WHERE company_id = $1`, [companyId]))
    expect(written.rowCount).toBe(0)
    await expect(withUserContext(userId, (client) => client.query(`SELECT public.arkiv_usage_add($1, 'asks', 1, '2026-09-17')`, [companyId]))).rejects.toThrow(/permission denied/)
  })
})
