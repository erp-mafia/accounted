import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20261125180000 (salary_line_items.settles_variable_vacation_pay) validated
 * by 20261125180100.
 *
 * The mark says a row pays semesterlön for rörliga lönedelar with the salary
 * under a central kollektivavtal (Semesterlagen 2 a § andra stycket,
 * lib/salary/variable-vacation-pay.ts). It defaults to false and is allowed
 * only on a manual semesterersättning row: never on the engine's own payout
 * row, which is the payment it replaces, and never on another type.
 */

async function constraintDef(): Promise<{ def: string; validated: boolean }> {
  const res = await getPool().query<{ def: string; validated: boolean }>(
    `SELECT pg_get_constraintdef(c.oid) AS def, c.convalidated AS validated
       FROM pg_constraint c
       JOIN pg_class t ON t.oid = c.conrelid
      WHERE t.relname = 'salary_line_items' AND c.conname = 'salary_line_items_settles_variable_vacation_pay_check'`,
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
     VALUES ($1, $2, $3, 'Rut', 'Rorlig', 'enc-payload', '1234', 'employee', '2026-01-01', 100, 'monthly')`,
    [employeeId, companyId, userId],
  )
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 11, '2026-11-25', 'draft')`,
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
  line: { itemType: string; calculationSource?: string | null; settles?: boolean },
) {
  const columns = line.settles === undefined ? '' : ', settles_variable_vacation_pay'
  const values = line.settles === undefined ? '' : ', $6'
  const params: unknown[] = [sreId, companyId, line.itemType, 600, line.calculationSource ?? null]
  if (line.settles !== undefined) params.push(line.settles)
  return getPool().query<{ id: string; settles_variable_vacation_pay: boolean }>(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction,
        calculation_source${columns})
     VALUES ($1, $2, $3, 'Rad', $4, true, true, false, false, false, $5${values})
     RETURNING id, settles_variable_vacation_pay`,
    params,
  )
}

describe('salary_line_items.settles_variable_vacation_pay', () => {
  it('is validated and names semesterersättning and the manual provenance', async () => {
    const def = await constraintDef()
    expect(def.validated).toBe(true)
    expect(def.def).toContain('semesterersattning')
    expect(def.def).toContain('calculation_source IS NULL')
  })

  it('defaults to false, so a row written without it keeps its meaning', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    const { rows } = await insertLine(companyId, sreId, { itemType: 'bonus' })
    expect(rows[0].settles_variable_vacation_pay).toBe(false)
    const engine = await insertLine(companyId, sreId, {
      itemType: 'semesterersattning',
      calculationSource: 'vacation_compensation',
    })
    expect(engine.rows[0].settles_variable_vacation_pay).toBe(false)
  })

  it('accepts the mark on a manual semesterersättning row', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    const { rows } = await insertLine(companyId, sreId, { itemType: 'semesterersattning', settles: true })
    expect(rows[0].settles_variable_vacation_pay).toBe(true)
  })

  it('refuses the mark on the engine\'s own payout row and on any other type (23514)', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    await expect(
      insertLine(companyId, sreId, {
        itemType: 'semesterersattning',
        calculationSource: 'vacation_compensation',
        settles: true,
      }),
    ).rejects.toMatchObject({ code: '23514' })
    for (const itemType of ['bonus', 'other', 'overtime', 'vacation']) {
      await expect(insertLine(companyId, sreId, { itemType, settles: true })).rejects.toMatchObject({ code: '23514' })
    }
  })

  it('refuses retyping a marked row away from semesterersättning (23514)', async () => {
    const { companyId, sreId } = await seedRunEmployee()
    const { rows } = await insertLine(companyId, sreId, { itemType: 'semesterersattning', settles: true })
    await expect(
      getPool().query(`UPDATE public.salary_line_items SET item_type = 'bonus' WHERE id = $1`, [rows[0].id]),
    ).rejects.toMatchObject({ code: '23514' })
  })
})
