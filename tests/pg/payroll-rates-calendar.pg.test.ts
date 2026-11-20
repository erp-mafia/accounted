import { describe, expect, it } from 'vitest'
import { PAYROLL_RATES_DUE, requiredYears } from '@/lib/salary/rates-calendar'
import { getPool } from '@/tests/pg/setup'

/**
 * Calendar tripwire for salary_payroll_config, against the schema the
 * migrations actually build. Payroll refuses a payment year without a row
 * (SALARY_PAYROLL_CONFIG_MISSING), so once PAYROLL_RATES_DUE has passed the
 * next year's row must already ship as a migration: this test then fails CI
 * until it does, instead of a customer finding out on January's payroll.
 *
 * When this fails: write next year's row from the official sources (the
 * regeluppdat loop's rate-year ticket lists every column and its source) in a
 * new migration. Never copy last year's values forward.
 */
describe('salary_payroll_config calendar', () => {
  it('has a row for every year payroll can be calculated in today', async () => {
    const { rows } = await getPool().query<{ config_year: number }>(
      'SELECT config_year FROM public.salary_payroll_config',
    )
    const seeded = new Set(rows.map((row) => Number(row.config_year)))
    for (const year of requiredYears(PAYROLL_RATES_DUE, new Date())) {
      expect(seeded.has(year), `salary_payroll_config has no row for ${year}`).toBe(true)
    }
  })
})
