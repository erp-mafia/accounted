import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20261023142500 (salary_line_items.calculation_source gains 'vacation_pay')
 * validated by 20261023142600, issue #85.
 *
 * The rows run-calculation derives from vacation days taken (semestertillägg,
 * semesterlön, semesterlöneavdrag, obetald semester, lib/salary/
 * vacation-days-pay.ts) carry calculation_source 'vacation_pay', allowed on
 * item_type 'vacation' only. NULL (manual) and 'vacation_compensation' are
 * accepted as before; anything else is refused.
 */

async function constraintDef(): Promise<{ def: string; validated: boolean }> {
  const res = await getPool().query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'salary_line_items' AND c.conname = 'salary_line_items_calculation_source_check'`,
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
     VALUES ($1, $2, $3, 'Sara', 'Semester', 'enc-payload', '1234', 'employee', '2026-01-01', 100, 'monthly')`,
    [employeeId, companyId, userId],
  )
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 7, '2026-07-25', 'draft')`,
    [runId, companyId, userId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_run_employees
       (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 40000, 'monthly')
     RETURNING id`,
    [runId, employeeId, companyId],
  )
  return { companyId, sreId: rows[0].id }
}

function insertLine(
  companyId: string,
  sreId: string,
  line: { itemType: string; amount: number; calculationSource: string | null; isGrossDeduction?: boolean },
) {
  return getPool().query(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction,
        calculation_source)
     VALUES ($1, $2, $3, 'Rad', $4, true, true, false, $5, false, $6)`,
    [sreId, companyId, line.itemType, line.amount, line.isGrossDeduction ?? false, line.calculationSource],
  )
}

describe('salary_line_items.calculation_source: vacation_pay (#85)', () => {
  it('is validated and names the new value with its item type', async () => {
    const def = await constraintDef()
    expect(def.validated).toBe(true)
    expect(def.def).toContain('vacation_compensation')
    expect(def.def).toContain('vacation_pay')
    expect(def.def).toContain("item_type = 'vacation'")
  })

  it('accepts the derived vacation rows: a semestertillägg and a semesterlöneavdrag', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    // 5 paid days x 0,43 % x 40 000 kr = 860 kr; 5 days x 1 904,76 kr = 9 523,80 kr.
    await expect(
      insertLine(companyId, sreId, { itemType: 'vacation', amount: 860, calculationSource: 'vacation_pay' }),
    ).resolves.toBeDefined()
    await expect(
      insertLine(companyId, sreId, {
        itemType: 'vacation',
        amount: -9523.8,
        calculationSource: 'vacation_pay',
        isGrossDeduction: true,
      }),
    ).resolves.toBeDefined()
  })

  it('keeps accepting a manual row and the semesterersättning provenance', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    await expect(insertLine(companyId, sreId, { itemType: 'vacation', amount: 0, calculationSource: null })).resolves.toBeDefined()
    await expect(
      insertLine(companyId, sreId, { itemType: 'semesterersattning', amount: 3600, calculationSource: 'vacation_compensation' }),
    ).resolves.toBeDefined()
  })

  it('refuses vacation_pay on any other item type, and an unknown value (23514)', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    for (const itemType of ['semesterersattning', 'other', 'unpaid_leave', 'monthly_salary']) {
      await expect(
        insertLine(companyId, sreId, { itemType, amount: 860, calculationSource: 'vacation_pay' }),
      ).rejects.toMatchObject({ code: '23514' })
    }
    await expect(
      insertLine(companyId, sreId, { itemType: 'vacation', amount: 860, calculationSource: 'vacation_days' }),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
