/**
 * ensureFiscalPeriod against a REAL PostgREST.
 *
 * The upsert's `onConflict` is a column list PostgREST hands to Postgres as
 * the ON CONFLICT arbiter, and Postgres refuses one that matches no unique
 * constraint (42P10). The multi-tenant refactor (20260330130000) moved the
 * fiscal_periods key from (user_id, period_start, period_end) to
 * (company_id, period_start, period_end); a mocked client cannot see that the
 * old list no longer names a constraint, so categorizing a bank row into a
 * year with no räkenskapsår failed to create the year on every booking path.
 */
import { describe, it, expect } from 'vitest'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  seedCompany,
} from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { createToolPgClient } from '@/tests/tool-pg/client'
import { ensureFiscalPeriod } from '@/lib/transactions/categorize-core'

async function periodsOf(companyId: string) {
  const { rows } = await getPool().query(
    `SELECT name, period_start::text AS period_start, period_end::text AS period_end, is_closed
       FROM public.fiscal_periods WHERE company_id = $1 ORDER BY period_start`,
    [companyId],
  )
  return rows as Array<{ name: string; period_start: string; period_end: string; is_closed: boolean }>
}

describe('ensureFiscalPeriod (real PostgREST)', () => {
  it('creates the missing next calendar year', async () => {
    const supabase = createToolPgClient()
    const { userId, companyId } = await seedCompany()

    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2027-03-15', 1)).resolves.toBe(true)

    expect(await periodsOf(companyId)).toEqual([
      expect.objectContaining({ period_start: '2026-01-01', period_end: '2026-12-31' }),
      { name: 'Räkenskapsår 2027', period_start: '2027-01-01', period_end: '2027-12-31', is_closed: false },
    ])
  })

  it('creates a missing broken fiscal year once, however often it is asked', async () => {
    const supabase = createToolPgClient()
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    await insertFiscalPeriod({ userId, companyId, periodStart: '2025-07-01', periodEnd: '2026-06-30' })

    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2026-09-01', 7)).resolves.toBe(true)
    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2027-02-01', 7)).resolves.toBe(true)

    expect((await periodsOf(companyId)).map((p) => [p.name, p.period_start, p.period_end])).toEqual([
      ['2026', '2025-07-01', '2026-06-30'],
      ['Räkenskapsår 2026/2027', '2026-07-01', '2027-06-30'],
    ])
  })

  it('chains from the recorded year when the settings month is out of step', async () => {
    const supabase = createToolPgClient()
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    const fy = await insertFiscalPeriod({ userId, companyId, periodStart: '2025-07-01', periodEnd: '2026-06-30' })

    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2026-08-05', 1)).resolves.toBe(true)

    expect((await periodsOf(companyId)).map((p) => [p.period_start, p.period_end])).toEqual([
      ['2025-07-01', '2026-06-30'],
      ['2026-07-01', '2027-06-30'],
    ])
    const { rows } = await getPool().query(
      `SELECT previous_period_id FROM public.fiscal_periods WHERE company_id = $1 AND period_start = '2026-07-01'`,
      [companyId],
    )
    expect(rows[0].previous_period_id).toBe(fy)
  })

  it('fills a hole wider than a year up to the date, year by year', async () => {
    const supabase = createToolPgClient()
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    await insertCompanyMember({ companyId, userId })
    await insertFiscalPeriod({ userId, companyId, periodStart: '2022-01-01', periodEnd: '2022-12-31' })
    await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31' })

    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2024-05-05', 1)).resolves.toBe(true)

    expect((await periodsOf(companyId)).map((p) => p.period_start)).toEqual([
      '2022-01-01',
      '2023-01-01',
      '2024-01-01',
      '2026-01-01',
    ])
  })

  it('answers false for an enskild firma on broken years: the database refuses the next one', async () => {
    const supabase = createToolPgClient()
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await insertCompanyMember({ companyId, userId })
    const client = await getPool().connect()
    try {
      await client.query(`SET session_replication_role = replica`)
      await client.query(
        `INSERT INTO public.fiscal_periods (user_id, company_id, name, period_start, period_end)
         VALUES ($1, $2, 'old', '2024-09-01', '2025-08-31')`,
        [userId, companyId],
      )
    } finally {
      await client.query(`SET session_replication_role = DEFAULT`)
      client.release()
    }

    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2025-10-01', 1)).resolves.toBe(false)

    expect(await periodsOf(companyId)).toHaveLength(1)
  })

  it('leaves a closed year with the same dates untouched', async () => {
    const supabase = createToolPgClient()
    const { userId, companyId } = await seedCompany({ isClosed: true })

    await expect(ensureFiscalPeriod(supabase, userId, companyId, '2026-05-01', 1)).resolves.toBe(true)

    expect(await periodsOf(companyId)).toEqual([
      { name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: true },
    ])
  })
})
