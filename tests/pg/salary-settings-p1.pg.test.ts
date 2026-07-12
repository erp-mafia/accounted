/**
 * pg-real tests for 20260703190000_salary_settings_p1.sql.
 *
 * Verifies:
 *   - preferred_payment_format defaults to 'pain001' for new rows (the old
 *     'bg_lb' default from 20260508120000 is retired — banks sunset
 *     Bankgirot Lön during 2026).
 *   - 'bg_lb' remains a valid explicit choice (companies with a working LB
 *     routine keep it; the UI warns instead).
 *   - salary_pay_day: default 25, CHECK 1–28.
 *   - salary_default_bank: NULL allowed, known keys allowed, unknown rejected.
 */
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { insertAuthUser, insertCompany } from './fixtures'

async function seedSettings(overrides: string = '', values: unknown[] = []): Promise<{
  userId: string
  companyId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id${overrides ? ', ' + overrides : ''})
     VALUES ($1, $2${values.map((_, i) => `, $${i + 3}`).join('')})`,
    [userId, companyId, ...values],
  )
  return { userId, companyId }
}

describe('salary settings P1 schema', () => {
  it('new company_settings rows default preferred_payment_format to pain001', async () => {
    const { companyId } = await seedSettings()
    const row = await getPool().query(
      `SELECT preferred_payment_format, salary_pay_day, salary_default_bank
         FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(row.rows[0].preferred_payment_format).toBe('pain001')
    expect(row.rows[0].salary_pay_day).toBe(25)
    expect(row.rows[0].salary_default_bank).toBeNull()
  })

  it('bg_lb stays a valid explicit format', async () => {
    const { companyId } = await seedSettings('preferred_payment_format', ['bg_lb'])
    const row = await getPool().query(
      `SELECT preferred_payment_format FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(row.rows[0].preferred_payment_format).toBe('bg_lb')
  })

  it('salary_pay_day accepts 1–28 and rejects out-of-range values', async () => {
    const { companyId } = await seedSettings('salary_pay_day', [28])
    const row = await getPool().query(
      `SELECT salary_pay_day FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(row.rows[0].salary_pay_day).toBe(28)

    await expect(seedSettings('salary_pay_day', [0])).rejects.toThrow()
    await expect(seedSettings('salary_pay_day', [29])).rejects.toThrow()
  })

  it('salary_default_bank accepts known keys + NULL and rejects unknown values', async () => {
    const { companyId } = await seedSettings('salary_default_bank', ['seb'])
    const row = await getPool().query(
      `SELECT salary_default_bank FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(row.rows[0].salary_default_bank).toBe('seb')

    await expect(seedSettings('salary_default_bank', ['danske'])).rejects.toThrow()
  })
})
