import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20261028030447 (crm#1492): a benefit payment names the benefit it pays for.
 *
 * benefit_type on employee_recurring_lines and salary_line_items is allowed
 * on item_type 'net_deduction_benefit_payment' only, in employee_benefits'
 * vocabulary. NULL stays valid everywhere (every existing row).
 */

async function seedEmployee(): Promise<{ companyId: string; userId: string; employeeId: string; sreId: string }> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_type, employment_start, employment_degree, salary_type)
     VALUES ($1, $2, $3, 'Bo', 'Bil', 'enc-payload', '1234', 'employee', '2026-01-01', 100, 'monthly')`,
    [employeeId, companyId, userId],
  )
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 10, '2026-10-25', 'draft')`,
    [runId, companyId, userId],
  )
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_run_employees
       (salary_run_id, employee_id, company_id, employment_degree, monthly_salary, salary_type)
     VALUES ($1, $2, $3, 100, 40000, 'monthly')
     RETURNING id`,
    [runId, employeeId, companyId],
  )
  return { companyId, userId, employeeId, sreId: rows[0].id }
}

function insertRecurring(
  seed: { companyId: string; userId: string; employeeId: string },
  itemType: string,
  benefitType: string | null,
) {
  return getPool().query(
    `INSERT INTO public.employee_recurring_lines
       (employee_id, company_id, user_id, item_type, description, amount, valid_from, benefit_type)
     VALUES ($1, $2, $3, $4, 'Avdrag', -1000, '2026-01-01', $5)`,
    [seed.employeeId, seed.companyId, seed.userId, itemType, benefitType],
  )
}

function insertPayslipLine(seed: { companyId: string; sreId: string }, itemType: string, benefitType: string | null) {
  return getPool().query(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, amount,
        is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction, benefit_type)
     VALUES ($1, $2, $3, 'Avdrag', -1000, false, false, false, false, true, $4)`,
    [seed.sreId, seed.companyId, itemType, benefitType],
  )
}

describe('benefit_type on a benefit payment (crm#1492)', () => {
  it('accepts a payment naming any benefit type, on the recurring line and the payslip row', async () => {
    const seed = await seedEmployee()
    for (const benefitType of ['bike', 'car', 'meals', 'housing', 'wellness', 'other']) {
      await expect(insertRecurring(seed, 'net_deduction_benefit_payment', benefitType)).resolves.toBeDefined()
      await expect(insertPayslipLine(seed, 'net_deduction_benefit_payment', benefitType)).resolves.toBeDefined()
    }
  })

  it('keeps NULL valid on every item type', async () => {
    const seed = await seedEmployee()
    await expect(insertRecurring(seed, 'net_deduction_benefit_payment', null)).resolves.toBeDefined()
    await expect(insertRecurring(seed, 'net_deduction_other', null)).resolves.toBeDefined()
    await expect(insertPayslipLine(seed, 'net_deduction_other', null)).resolves.toBeDefined()
  })

  it('refuses a benefit on another item type, and an unknown benefit (23514)', async () => {
    const seed = await seedEmployee()
    await expect(insertRecurring(seed, 'net_deduction_other', 'car')).rejects.toMatchObject({ code: '23514' })
    await expect(insertPayslipLine(seed, 'net_deduction_union', 'car')).rejects.toMatchObject({ code: '23514' })
    await expect(insertRecurring(seed, 'net_deduction_benefit_payment', 'benefit_car')).rejects.toMatchObject({
      code: '23514',
    })
    await expect(insertPayslipLine(seed, 'net_deduction_benefit_payment', 'fuel')).rejects.toMatchObject({
      code: '23514',
    })
  })
})
