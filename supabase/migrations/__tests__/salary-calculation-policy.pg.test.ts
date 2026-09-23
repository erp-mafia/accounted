import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20260919120000 (salary_line_items.calculation_source), 20260919120100
 * (company_settings.salary_calculation_policy) and 20260919120200
 * (salary_line_items.one_off_tax_percent), validated by 20260919120300:
 *
 *   - the policy column defaults to {} and its CHECK closes both the key set
 *     and each convention's enum, mirroring SalaryCalculationPolicySchema;
 *   - one_off_tax_percent is only accepted on a positive taxable addition of
 *     an eligible wage type, mirroring validateOneOffTaxLine;
 *   - calculation_source is NULL or 'vacation_compensation'.
 */

async function constraintDef(table: string, name: string): Promise<{ def: string; validated: boolean }> {
  const res = await getPool().query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = $1 AND c.conname = $2`,
    [table, name],
  )
  return res.rows[0] ?? { def: '', validated: false }
}

async function seedRunEmployee(): Promise<{ companyId: string; sreId: string }> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_type, employment_start, employment_degree, salary_type)
     VALUES ($1, $2, $3, 'Anna', 'Anställd', 'enc-payload', '1234', 'employee', '2026-01-01', 100, 'monthly')`,
    [employeeId, companyId, userId],
  )
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 9, '2026-09-25', 'draft')`,
    [runId, companyId, userId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_run_employees
       (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 30000, 'monthly')
     RETURNING id`,
    [runId, employeeId, companyId],
  )
  return { companyId, sreId: rows[0].id }
}

function insertLine(
  companyId: string,
  sreId: string,
  line: {
    itemType: string
    amount: number
    oneOffTaxPercent?: number | null
    isTaxable?: boolean
    isGrossDeduction?: boolean
    isNetDeduction?: boolean
    calculationSource?: string | null
  },
) {
  return getPool().query(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction,
        one_off_tax_percent, calculation_source)
     VALUES ($1, $2, $3, 'Rad', $4, $5, true, false, $6, $7, $8, $9)`,
    [
      sreId,
      companyId,
      line.itemType,
      line.amount,
      line.isTaxable ?? true,
      line.isGrossDeduction ?? false,
      line.isNetDeduction ?? false,
      line.oneOffTaxPercent ?? null,
      line.calculationSource ?? null,
    ],
  )
}

describe('company_settings.salary_calculation_policy', () => {
  it('defaults to the empty object (every convention at its default)', async () => {
    const { companyId } = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (company_id) VALUES ($1)`, [companyId])
    const res = await getPool().query<{ salary_calculation_policy: Record<string, unknown> }>(
      `SELECT salary_calculation_policy FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(res.rows[0].salary_calculation_policy).toEqual({})
  })

  it('accepts every convention at either value, as one object', async () => {
    const { companyId } = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (company_id) VALUES ($1)`, [companyId])
    const full = {
      partial_month: 'annual_calendar_days',
      sick_rate: 'annual_hourly',
      long_leave: 'calendar_after_five_workdays',
      leave_context: 'through_deviation_end',
      net_rounding: 'nearest',
      one_off_tax_rounding: 'nearest',
    }
    await expect(
      getPool().query(
        `UPDATE public.company_settings SET salary_calculation_policy = $2::jsonb WHERE company_id = $1`,
        [companyId, JSON.stringify(full)],
      ),
    ).resolves.toBeDefined()
    await expect(
      getPool().query(
        `UPDATE public.company_settings SET salary_calculation_policy = $2::jsonb WHERE company_id = $1`,
        [companyId, JSON.stringify({ sick_rate: 'daily_divisor' })],
      ),
    ).resolves.toBeDefined()
  })

  it('rejects a non-object, an unknown key and a misspelled value (23514)', async () => {
    const { companyId } = await seedCompany()
    await getPool().query(`INSERT INTO public.company_settings (company_id) VALUES ($1)`, [companyId])
    for (const bad of [
      '[]',
      '"workdays"',
      JSON.stringify({ partial_month: 'workdays', unknown: 'x' }),
      JSON.stringify({ sick_rate: 'anual_hourly' }),
      JSON.stringify({ net_rounding: 'down' }),
      JSON.stringify({ long_leave: 'calendar' }),
    ]) {
      await expect(
        getPool().query(
          `UPDATE public.company_settings SET salary_calculation_policy = $2::jsonb WHERE company_id = $1`,
          [companyId, bad],
        ),
      ).rejects.toMatchObject({ code: '23514' })
    }
  })
})

describe('salary_line_items.one_off_tax_percent', () => {
  it('is validated (not left NOT VALID) and defaults to NULL', async () => {
    const def = await constraintDef('salary_line_items', 'salary_line_items_one_off_tax_percent_check')
    expect(def.def).toContain('semesterersattning')
    expect(def.validated).toBe(true)
    const { companyId, sreId } = await seedRunEmployee()
    await expect(insertLine(companyId, sreId, { itemType: 'bonus', amount: 5000 })).resolves.toBeDefined()
    const res = await getPool().query<{ one_off_tax_percent: string | null }>(
      `SELECT one_off_tax_percent FROM public.salary_line_items WHERE salary_run_employee_id = $1`,
      [sreId],
    )
    expect(res.rows[0].one_off_tax_percent).toBeNull()
  })

  it('accepts a percentage on a positive taxable bonus, commission, other, correction or semesterersattning', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    for (const itemType of ['bonus', 'commission', 'other', 'correction', 'semesterersattning']) {
      await expect(
        insertLine(companyId, sreId, { itemType, amount: 2500, oneOffTaxPercent: 30 }),
      ).resolves.toBeDefined()
    }
    await expect(insertLine(companyId, sreId, { itemType: 'bonus', amount: 1, oneOffTaxPercent: 0 })).resolves.toBeDefined()
    await expect(insertLine(companyId, sreId, { itemType: 'bonus', amount: 1, oneOffTaxPercent: 100 })).resolves.toBeDefined()
  })

  it('rejects a percentage outside 0-100, on a non-positive amount, a deduction, a non-taxable row or another wage type (23514)', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    const cases = [
      { itemType: 'bonus', amount: 2500, oneOffTaxPercent: 100.01 },
      { itemType: 'bonus', amount: 2500, oneOffTaxPercent: -1 },
      { itemType: 'bonus', amount: 0, oneOffTaxPercent: 30 },
      { itemType: 'bonus', amount: -2500, oneOffTaxPercent: 30 },
      { itemType: 'bonus', amount: 2500, oneOffTaxPercent: 30, isTaxable: false },
      { itemType: 'bonus', amount: 2500, oneOffTaxPercent: 30, isGrossDeduction: true },
      { itemType: 'bonus', amount: 2500, oneOffTaxPercent: 30, isNetDeduction: true },
      { itemType: 'benefit_car', amount: 2500, oneOffTaxPercent: 30 },
      { itemType: 'overtime', amount: 2500, oneOffTaxPercent: 30 },
      { itemType: 'monthly_salary', amount: 30000, oneOffTaxPercent: 30 },
    ]
    for (const line of cases) {
      await expect(insertLine(companyId, sreId, line)).rejects.toMatchObject({ code: '23514' })
    }
  })
})

describe('salary_line_items.calculation_source', () => {
  it('is validated and accepts NULL or vacation_compensation only', async () => {
    const def = await constraintDef('salary_line_items', 'salary_line_items_calculation_source_check')
    expect(def.def).toContain('vacation_compensation')
    expect(def.validated).toBe(true)
    const { companyId, sreId } = await seedRunEmployee()
    await expect(
      insertLine(companyId, sreId, { itemType: 'semesterersattning', amount: 3600, calculationSource: 'vacation_compensation' }),
    ).resolves.toBeDefined()
    await expect(
      insertLine(companyId, sreId, { itemType: 'semesterersattning', amount: 3600, calculationSource: null }),
    ).resolves.toBeDefined()
    await expect(
      insertLine(companyId, sreId, { itemType: 'semesterersattning', amount: 3600, calculationSource: 'manual' }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
