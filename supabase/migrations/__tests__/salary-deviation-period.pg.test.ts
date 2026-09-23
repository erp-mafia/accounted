import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20260918120000_salary_deviation_period.sql: the company default is a
 * closed enum with 'same_month' as the default, and a run's window is either
 * absent on both bounds or present and ordered on both.
 */

async function constraintDef(table: string, name: string): Promise<string> {
  const res = await getPool().query<{ def: string }>(
    `SELECT pg_get_constraintdef(c.oid) AS def
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.conname = $2`,
    [table, name],
  )
  return res.rows[0]?.def ?? ''
}

async function seed(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  return { userId, companyId }
}

function insertRun(params: {
  userId: string
  companyId: string
  month: number
  start: string | null
  end: string | null
}) {
  return getPool().query(
    `INSERT INTO public.salary_runs
       (id, company_id, user_id, period_year, period_month, payment_date,
        deviation_period_start, deviation_period_end)
     VALUES ($1, $2, $3, 2026, $4, $5, $6, $7)`,
    [
      randomUUID(),
      params.companyId,
      params.userId,
      params.month,
      `2026-${String(params.month).padStart(2, '0')}-25`,
      params.start,
      params.end,
    ],
  )
}

describe('company_settings.salary_deviation_period', () => {
  it('defaults to same_month and is a closed enum', async () => {
    expect(await constraintDef('company_settings', 'company_settings_salary_deviation_period_check')).toContain(
      'previous_month',
    )
    const { companyId } = await seed()
    await getPool().query(`INSERT INTO public.company_settings (company_id) VALUES ($1)`, [companyId])
    const res = await getPool().query<{ salary_deviation_period: string }>(
      `SELECT salary_deviation_period FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(res.rows[0].salary_deviation_period).toBe('same_month')

    await expect(
      getPool().query(
        `UPDATE public.company_settings SET salary_deviation_period = 'previous_month' WHERE company_id = $1`,
        [companyId],
      ),
    ).resolves.toBeDefined()
    await expect(
      getPool().query(
        `UPDATE public.company_settings SET salary_deviation_period = 'fortnightly' WHERE company_id = $1`,
        [companyId],
      ),
    ).rejects.toMatchObject({ code: '23514' })
  })
})

describe('salary_runs deviation window', () => {
  it('accepts no window (legacy rows) and a complete ordered window', async () => {
    const { userId, companyId } = await seed()
    await expect(insertRun({ userId, companyId, month: 8, start: null, end: null })).resolves.toBeDefined()
    await expect(
      insertRun({ userId, companyId, month: 9, start: '2026-08-01', end: '2026-08-31' }),
    ).resolves.toBeDefined()
  })

  it('rejects one bound without the other', async () => {
    const { userId, companyId } = await seed()
    await expect(
      insertRun({ userId, companyId, month: 9, start: '2026-08-01', end: null }),
    ).rejects.toMatchObject({ code: '23514' })
    await expect(
      insertRun({ userId, companyId, month: 9, start: null, end: '2026-08-31' }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('rejects an inverted window', async () => {
    const { userId, companyId } = await seed()
    await expect(
      insertRun({ userId, companyId, month: 9, start: '2026-08-31', end: '2026-08-01' }),
    ).rejects.toMatchObject({ code: '23514' })
  })

  it('caps the window at two months (62 days inclusive), same as the application', async () => {
    const { userId, companyId } = await seed()
    await expect(
      insertRun({ userId, companyId, month: 9, start: '2026-07-01', end: '2026-08-31' }),
    ).resolves.toBeDefined()
    await expect(
      insertRun({ userId, companyId, month: 10, start: '2026-06-30', end: '2026-08-31' }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
