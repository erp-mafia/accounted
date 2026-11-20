import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool } from './setup'
import { seedCompany } from './fixtures'

// pg-real coverage for 20261014233000_payslip_text_rows (+ 20261014233100):
//   - salary_line_items accepts item_type 'text', and
//     salary_line_items_text_row binds it to words only: amount 0, no
//     quantity, no unit price, no account, every flag false, non-blank text
//   - money rows ('other' and friends) are untouched by the new CHECK
//   - both salary_line_items CHECKs end up validated (not left NOT VALID)
//   - employee_recurring_lines accepts a 'text' row (amount 0, no account)
//     while deductions keep the negative-amount rule

async function seedEmployee(): Promise<{ userId: string; companyId: string; employeeId: string }> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  return { userId, companyId, employeeId }
}

/** One draft run with one employee on it; returns the payslip (sre) id. */
async function seedPayslip(): Promise<{ companyId: string; sreId: string }> {
  const { userId, companyId, employeeId } = await seedEmployee()
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 10, '2026-10-25', 'draft')`,
    [runId, companyId, userId],
  )
  const sreId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
     VALUES ($1, $2, $3, $4, 'monthly', 35000, 100)`,
    [sreId, runId, employeeId, companyId],
  )
  return { companyId, sreId }
}

type LineFields = {
  item_type: string
  description: string
  quantity: number | null
  unit_price: number | null
  amount: number
  account_number: string | null
  is_taxable: boolean
  is_avgift_basis: boolean
  is_vacation_basis: boolean
  is_gross_deduction: boolean
  is_net_deduction: boolean
}

const VALID_TEXT_ROW: LineFields = {
  item_type: 'text',
  description: 'Lönen består av grundlön och tillägg enligt kollektivavtal',
  quantity: null,
  unit_price: null,
  amount: 0,
  account_number: null,
  is_taxable: false,
  is_avgift_basis: false,
  is_vacation_basis: false,
  is_gross_deduction: false,
  is_net_deduction: false,
}

async function insertSalaryLine(sreId: string, companyId: string, fields: Partial<LineFields> = {}): Promise<string> {
  const f = { ...VALID_TEXT_ROW, ...fields }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.salary_line_items
       (salary_run_employee_id, company_id, item_type, description, quantity, unit_price, amount, account_number,
        is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      sreId,
      companyId,
      f.item_type,
      f.description,
      f.quantity,
      f.unit_price,
      f.amount,
      f.account_number,
      f.is_taxable,
      f.is_avgift_basis,
      f.is_vacation_basis,
      f.is_gross_deduction,
      f.is_net_deduction,
    ],
  )
  return rows[0].id
}

async function insertRecurringLine(
  seed: { userId: string; companyId: string; employeeId: string },
  fields: { itemType: string; amount: number; account?: string | null; description?: string },
): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO public.employee_recurring_lines
       (employee_id, company_id, user_id, item_type, description, amount, account_number, valid_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-01-01')
     RETURNING id`,
    [
      seed.employeeId,
      seed.companyId,
      seed.userId,
      fields.itemType,
      fields.description ?? 'Lönen består av grundlön enligt avtal',
      fields.amount,
      fields.account ?? null,
    ],
  )
  return rows[0].id
}

describe('salary_line_items text rows', () => {
  it('accepts a text row: words only, amount 0, no quantity, price, account or flags', async () => {
    const { companyId, sreId } = await seedPayslip()
    const id = await insertSalaryLine(sreId, companyId)

    const { rows } = await getPool().query(
      `SELECT item_type, description, amount, quantity, unit_price, account_number,
              is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction
         FROM public.salary_line_items WHERE id = $1`,
      [id],
    )
    expect(rows[0]).toMatchObject({
      item_type: 'text',
      quantity: null,
      unit_price: null,
      account_number: null,
      is_taxable: false,
      is_avgift_basis: false,
      is_vacation_basis: false,
      is_gross_deduction: false,
      is_net_deduction: false,
    })
    expect(Number(rows[0].amount)).toBe(0)
  })

  it.each<[string, Partial<LineFields>]>([
    ['a positive amount', { amount: 100 }],
    ['a negative amount', { amount: -0.01 }],
    ['a quantity', { quantity: 1 }],
    ['a unit price', { unit_price: 250 }],
    ['an account', { account_number: '7010' }],
    ['is_taxable', { is_taxable: true }],
    ['is_avgift_basis', { is_avgift_basis: true }],
    ['is_vacation_basis', { is_vacation_basis: true }],
    ['is_gross_deduction', { is_gross_deduction: true }],
    ['is_net_deduction', { is_net_deduction: true }],
    ['an empty description', { description: '' }],
    ['a whitespace-only description', { description: '   ' }],
    ['a description of tabs and line breaks', { description: '\t\n\r ' }],
  ])('refuses a text row with %s', async (_label, fields) => {
    const { companyId, sreId } = await seedPayslip()
    await expect(insertSalaryLine(sreId, companyId, fields)).rejects.toMatchObject({
      code: '23514',
      constraint: 'salary_line_items_text_row',
    })
  })

  it('refuses turning an existing text row into a money row in place', async () => {
    const { companyId, sreId } = await seedPayslip()
    const id = await insertSalaryLine(sreId, companyId)
    await expect(
      getPool().query(`UPDATE public.salary_line_items SET amount = 500 WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'salary_line_items_text_row' })
  })

  it('leaves money rows alone: an other row with amount 0, quantity, price, account and flags inserts', async () => {
    const { companyId, sreId } = await seedPayslip()
    await expect(
      insertSalaryLine(sreId, companyId, {
        item_type: 'other',
        description: 'Övrigt',
        quantity: 1,
        unit_price: 0,
        amount: 0,
        account_number: '7010',
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
      }),
    ).resolves.toBeTruthy()
    await expect(
      insertSalaryLine(sreId, companyId, {
        item_type: 'other',
        description: 'Övrigt tillägg',
        quantity: 2,
        unit_price: 250,
        amount: 500,
        account_number: '7010',
        is_taxable: true,
        is_avgift_basis: true,
        is_vacation_basis: true,
      }),
    ).resolves.toBeTruthy()
  })

  it('still refuses an unknown item type', async () => {
    const { companyId, sreId } = await seedPayslip()
    await expect(insertSalaryLine(sreId, companyId, { item_type: 'textrad' })).rejects.toMatchObject({
      code: '23514',
      constraint: 'salary_line_items_item_type_check',
    })
  })

  it('both salary_line_items CHECKs are validated (not left NOT VALID)', async () => {
    const res = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT c.conname, c.convalidated
         FROM pg_constraint c
        WHERE c.conrelid = 'public.salary_line_items'::regclass
          AND c.conname IN ('salary_line_items_item_type_check', 'salary_line_items_text_row')
        ORDER BY c.conname`,
    )
    expect(res.rows).toEqual([
      { conname: 'salary_line_items_item_type_check', convalidated: true },
      { conname: 'salary_line_items_text_row', convalidated: true },
    ])
  })
})

describe('employee_recurring_lines text rows', () => {
  it('accepts a text row with amount 0 and no account', async () => {
    const seed = await seedEmployee()
    await expect(insertRecurringLine(seed, { itemType: 'text', amount: 0 })).resolves.toBeTruthy()
  })

  it.each<[string, { amount: number; account?: string | null }]>([
    ['a positive amount', { amount: 100 }],
    ['a negative amount', { amount: -100 }],
    ['an account', { amount: 0, account: '7010' }],
  ])('refuses a text row with %s', async (_label, fields) => {
    const seed = await seedEmployee()
    await expect(insertRecurringLine(seed, { itemType: 'text', ...fields })).rejects.toMatchObject({
      code: '23514',
      constraint: 'employee_recurring_lines_text_row',
    })
  })

  it('keeps the negative-amount rule for deductions', async () => {
    const seed = await seedEmployee()
    await expect(
      insertRecurringLine(seed, { itemType: 'gross_deduction_other', amount: 0 }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employee_recurring_lines_amount_sign' })
    await expect(
      insertRecurringLine(seed, { itemType: 'net_deduction_union', amount: 250 }),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employee_recurring_lines_amount_sign' })
    await expect(
      insertRecurringLine(seed, { itemType: 'gross_deduction_other', amount: -670.17, account: '7399' }),
    ).resolves.toBeTruthy()
  })

  it('still refuses non-deduction money types such as other', async () => {
    const seed = await seedEmployee()
    await expect(insertRecurringLine(seed, { itemType: 'other', amount: -500 })).rejects.toMatchObject({
      code: '23514',
      constraint: 'employee_recurring_lines_item_type_check',
    })
  })

  it('all three CHECKs are validated', async () => {
    const res = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT c.conname, c.convalidated
         FROM pg_constraint c
        WHERE c.conrelid = 'public.employee_recurring_lines'::regclass
          AND c.conname IN (
            'employee_recurring_lines_item_type_check',
            'employee_recurring_lines_amount_sign',
            'employee_recurring_lines_text_row'
          )
        ORDER BY c.conname`,
    )
    expect(res.rows).toEqual([
      { conname: 'employee_recurring_lines_amount_sign', convalidated: true },
      { conname: 'employee_recurring_lines_item_type_check', convalidated: true },
      { conname: 'employee_recurring_lines_text_row', convalidated: true },
    ])
  })
})
