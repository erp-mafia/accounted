/**
 * pg-real tests for 20261015010000_salary_line_default_accounts_resolved_at_booking.sql
 * and 20261015010100_employees_personnel_category.sql (Plan 1: right salary
 * accounts per employee).
 *
 * salary_line_items.account_number became an override only: NULL books on the
 * default the booking resolves from the item type, the employment type and
 * the personnel category. The backfill clears the defaults the old write
 * sites cached on unbooked runs and must leave overrides, utlägg lines and
 * booked runs alone; the category columns default to tjänsteman (how every
 * existing row was booked) and accept only the two categories.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { seedCompany } from '@/tests/pg/fixtures'

const BACKFILL_SQL = readFileSync(
  join(process.cwd(), 'supabase/migrations/20261015010000_salary_line_default_accounts_resolved_at_booking.sql'),
  'utf8',
)

async function insertEmployee(companyId: string, userId: string, employmentType: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start, employment_type)
     VALUES ($1, $2, $3, 'Test', 'Testsson', $5, '0000', '2026-01-01', $4)`,
    // personnummer is unique per company: one encrypted payload per employee.
    [id, companyId, userId, employmentType, `enc-${id}`],
  )
  return id
}

async function insertRun(companyId: string, userId: string, status: string, month: number): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, $4, make_date(2026, $4, 25), $5)`,
    [id, companyId, userId, month, status],
  )
  return id
}

async function insertRunEmployee(companyId: string, runId: string, employeeId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
     VALUES ($1, $2, $3, $4, 'monthly', 30000, 100)`,
    [id, runId, employeeId, companyId],
  )
  return id
}

async function insertLine(
  companyId: string,
  sreId: string,
  itemType: string,
  accountNumber: string | null,
  amount = 1000,
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_line_items
       (id, salary_run_employee_id, company_id, item_type, description, quantity, amount, account_number)
     VALUES ($1, $2, $3, $4, 'Rad', 1, $5, $6)`,
    [id, sreId, companyId, itemType, amount, accountNumber],
  )
  return id
}

async function accountOf(lineId: string): Promise<string | null> {
  const { rows } = await getPool().query<{ account_number: string | null }>(
    `SELECT account_number FROM public.salary_line_items WHERE id = $1`,
    [lineId],
  )
  return rows[0].account_number
}

describe('backfill: cached default accounts on unbooked runs', () => {
  it('clears cached defaults and keeps overrides, utlägg lines and booked runs', async () => {
    const { userId, companyId } = await seedCompany()
    const employee = await insertEmployee(companyId, userId, 'employee')
    const owner = await insertEmployee(companyId, userId, 'company_owner')
    const board = await insertEmployee(companyId, userId, 'board_member')

    const draft = await insertRun(companyId, userId, 'draft', 9)
    const paid = await insertRun(companyId, userId, 'paid', 8)
    const booked = await insertRun(companyId, userId, 'booked', 7)

    const draftEmployee = await insertRunEmployee(companyId, draft, employee)
    const draftOwner = await insertRunEmployee(companyId, draft, owner)
    const draftBoard = await insertRunEmployee(companyId, draft, board)
    const paidEmployee = await insertRunEmployee(companyId, paid, employee)
    const bookedEmployee = await insertRunEmployee(companyId, booked, employee)

    const cleared = [
      await insertLine(companyId, draftEmployee, 'monthly_salary', '7210'),
      await insertLine(companyId, draftEmployee, 'net_deduction_union', '2794', -300),
      await insertLine(companyId, draftEmployee, 'vacation', '7285'),
      // The bug: an owner's hourly line cached 7210 without the owner's type.
      await insertLine(companyId, draftOwner, 'hourly_salary', '7210'),
      await insertLine(companyId, draftOwner, 'unpaid_leave', '7220', -500),
      await insertLine(companyId, draftOwner, 'semesterersattning', '7286'),
      await insertLine(companyId, draftBoard, 'monthly_salary', '7240'),
      await insertLine(companyId, paidEmployee, 'bonus', '7210'),
    ]
    const kept = new Map<string, string | null>([
      // A deliberate override: not the default of its item type.
      [await insertLine(companyId, draftEmployee, 'bonus', '7010'), '7010'],
      [await insertLine(companyId, draftEmployee, 'net_deduction_benefit_payment', '7381', -200), '7381'],
      // An owner account on a tjänsteman is not a default: an override.
      [await insertLine(companyId, draftEmployee, 'commission', '7220'), '7220'],
      // Utlägg carry their claim's liability account.
      [await insertLine(companyId, draftEmployee, 'expense_reimbursement', '2820'), '2820'],
      // A booked run's lines are the record of what was posted.
      [await insertLine(companyId, bookedEmployee, 'monthly_salary', '7210'), '7210'],
      [await insertLine(companyId, draftEmployee, 'other', null), null],
    ])

    await getPool().query(BACKFILL_SQL)

    for (const id of cleared) expect(await accountOf(id)).toBeNull()
    for (const [id, account] of kept) expect(await accountOf(id)).toBe(account)
  })

  it('is idempotent: a second run changes nothing', async () => {
    const { userId, companyId } = await seedCompany()
    const employee = await insertEmployee(companyId, userId, 'employee')
    const run = await insertRun(companyId, userId, 'review', 10)
    const sre = await insertRunEmployee(companyId, run, employee)
    const line = await insertLine(companyId, sre, 'bonus', '7210')
    const override = await insertLine(companyId, sre, 'bonus', '7010')

    await getPool().query(BACKFILL_SQL)
    await getPool().query(BACKFILL_SQL)

    expect(await accountOf(line)).toBeNull()
    expect(await accountOf(override)).toBe('7010')
  })
})

describe('personnel_category', () => {
  it('defaults to tjansteman on employees and on the roster stamp', async () => {
    const { userId, companyId } = await seedCompany()
    const employee = await insertEmployee(companyId, userId, 'employee')
    const run = await insertRun(companyId, userId, 'draft', 11)
    const sre = await insertRunEmployee(companyId, run, employee)

    const { rows: emp } = await getPool().query(`SELECT personnel_category FROM public.employees WHERE id = $1`, [employee])
    const { rows: stamp } = await getPool().query(
      `SELECT personnel_category FROM public.salary_run_employees WHERE id = $1`,
      [sre],
    )
    expect(emp[0].personnel_category).toBe('tjansteman')
    expect(stamp[0].personnel_category).toBe('tjansteman')
  })

  it('accepts arbetare and refuses anything else, on both tables', async () => {
    const { userId, companyId } = await seedCompany()
    const employee = await insertEmployee(companyId, userId, 'employee')
    const run = await insertRun(companyId, userId, 'draft', 12)
    const sre = await insertRunEmployee(companyId, run, employee)

    await getPool().query(`UPDATE public.employees SET personnel_category = 'arbetare' WHERE id = $1`, [employee])
    await getPool().query(`UPDATE public.salary_run_employees SET personnel_category = 'arbetare' WHERE id = $1`, [sre])

    await expect(
      getPool().query(`UPDATE public.employees SET personnel_category = 'kollektiv' WHERE id = $1`, [employee]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'employees_personnel_category_check' })
    await expect(
      getPool().query(`UPDATE public.salary_run_employees SET personnel_category = NULL WHERE id = $1`, [sre]),
    ).rejects.toMatchObject({ code: '23502' })
    await expect(
      getPool().query(`UPDATE public.salary_run_employees SET personnel_category = 'owner' WHERE id = $1`, [sre]),
    ).rejects.toMatchObject({ code: '23514', constraint: 'salary_run_employees_personnel_category_check' })
  })
})
