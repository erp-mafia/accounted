/**
 * pg-real tests for 20261014234000_employees_extra_tax_withholding.sql
 * (förhöjt skatteavdrag per employee, SFL 11 kap. 22 §).
 *
 * The application refuses both forms at once on every door
 * (lib/salary/extra-tax.ts validateExtraTax), but two edits that each set
 * one form can interleave, and a direct write never sees the validator. The
 * constraints are the backstop.
 *
 * Verifies:
 *   - extra_tax_amount: whole kronor 1 to 1 000 000;
 *   - extra_tax_percentage: above 0, at most 100;
 *   - at most one form set, on INSERT and on UPDATE, with SQLSTATE 23514
 *     naming employees_extra_tax_one_form_check (what extraTaxIssueFromDbError
 *     keys on); switching the form in one statement is accepted;
 *   - salary_run_employees.extra_tax_withheld: NOT NULL, default 0, never
 *     negative.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

const ONE_FORM = 'employees_extra_tax_one_form_check'

interface PgError extends Error {
  code?: string
  constraint?: string
}

interface ExtraTax {
  amount: number | null
  percentage: number | null
}

async function seedCompany(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

async function insertEmployee(seed: { companyId: string; userId: string }, x: ExtraTax): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_start, extra_tax_amount, extra_tax_percentage)
     VALUES ($1, $2, $3, 'Test', 'Testsson', $4, '0000', '2026-01-01', $5, $6)`,
    // personnummer is unique per company; the ciphertext is never decrypted here.
    [id, seed.companyId, seed.userId, `enc-${id}`, x.amount, x.percentage],
  )
  return id
}

async function readExtraTax(id: string): Promise<ExtraTax> {
  const res = await getPool().query<{ extra_tax_amount: number | null; extra_tax_percentage: string | null }>(
    'SELECT extra_tax_amount, extra_tax_percentage FROM public.employees WHERE id = $1',
    [id],
  )
  const row = res.rows[0]
  return {
    amount: row.extra_tax_amount,
    percentage: row.extra_tax_percentage === null ? null : Number(row.extra_tax_percentage),
  }
}

async function captureError(promise: Promise<unknown>): Promise<PgError> {
  try {
    await promise
  } catch (err) {
    return err as PgError
  }
  throw new Error('expected the statement to be rejected')
}

function expectRejection(err: PgError, constraint: string) {
  expect(err.code).toBe('23514')
  expect(err.constraint).toBe(constraint)
}

describe('employees.extra_tax_amount', () => {
  it('accepts whole kronor from 1 to 1 000 000', async () => {
    const seed = await seedCompany()
    expect(await readExtraTax(await insertEmployee(seed, { amount: 1, percentage: null }))).toEqual({ amount: 1, percentage: null })
    expect(await readExtraTax(await insertEmployee(seed, { amount: 1_000_000, percentage: null }))).toMatchObject({ amount: 1_000_000 })
  })

  it.each([0, -500, 1_000_001])('rejects %d', async (amount) => {
    const seed = await seedCompany()
    expectRejection(await captureError(insertEmployee(seed, { amount, percentage: null })), 'employees_extra_tax_amount_check')
  })
})

describe('employees.extra_tax_percentage', () => {
  it('accepts above 0 up to 100', async () => {
    const seed = await seedCompany()
    expect(await readExtraTax(await insertEmployee(seed, { amount: null, percentage: 45 }))).toEqual({ amount: null, percentage: 45 })
    expect(await readExtraTax(await insertEmployee(seed, { amount: null, percentage: 100 }))).toMatchObject({ percentage: 100 })
    expect(await readExtraTax(await insertEmployee(seed, { amount: null, percentage: 0.01 }))).toMatchObject({ percentage: 0.01 })
  })

  it.each([0, -1, 100.01])('rejects %d', async (percentage) => {
    const seed = await seedCompany()
    expectRejection(
      await captureError(insertEmployee(seed, { amount: null, percentage })),
      'employees_extra_tax_percentage_check',
    )
  })
})

describe('one form at a time', () => {
  it('rejects both forms on INSERT', async () => {
    const seed = await seedCompany()
    const err = await captureError(insertEmployee(seed, { amount: 500, percentage: 45 }))
    expectRejection(err, ONE_FORM)
    expect(err.message).toBe(`new row for relation "employees" violates check constraint "${ONE_FORM}"`)
  })

  it('rejects setting the other form on UPDATE (the concurrent-edit shape)', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { amount: 500, percentage: null })
    const err = await captureError(
      getPool().query('UPDATE public.employees SET extra_tax_percentage = 45 WHERE id = $1', [id]),
    )
    expectRejection(err, ONE_FORM)
    expect(await readExtraTax(id)).toEqual({ amount: 500, percentage: null })
  })

  it('accepts switching the form in one statement', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { amount: 500, percentage: null })
    await getPool().query(
      'UPDATE public.employees SET extra_tax_amount = NULL, extra_tax_percentage = 45 WHERE id = $1',
      [id],
    )
    expect(await readExtraTax(id)).toEqual({ amount: null, percentage: 45 })
  })
})

describe('salary_run_employees.extra_tax_withheld', () => {
  it('is NOT NULL with default 0 and refuses a negative value', async () => {
    const col = await getPool().query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'salary_run_employees' AND column_name = 'extra_tax_withheld'`,
    )
    expect(col.rows).toHaveLength(1)
    expect(col.rows[0].is_nullable).toBe('NO')
    expect(col.rows[0].column_default).toBe('0')

    const check = await getPool().query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conname = 'salary_run_employees_extra_tax_withheld_check'
          AND conrelid = 'public.salary_run_employees'::regclass`,
    )
    expect(check.rows[0]?.def).toContain('extra_tax_withheld >= (0)::numeric')
  })
})
