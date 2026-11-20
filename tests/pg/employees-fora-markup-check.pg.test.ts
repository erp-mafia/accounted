/**
 * pg-real tests for 20261022201639_employees_fora_markup.sql (the Fora FOK
 * code an employee is reported to Fora under).
 *
 * Every door refuses these first (lib/salary/fora/markup.ts); the
 * constraints are the backstop for a direct write.
 *
 * Verifies:
 *   - fora_fok_id is 'FOK' plus six digits;
 *   - the code and its start date are set together or not at all;
 *   - a code only on employment_type 'employee', on INSERT and when an
 *     UPDATE turns a coded employee into an owner;
 *   - an employee without a code is unaffected.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

interface PgError extends Error {
  code?: string
  constraint?: string
}

interface Markup {
  fokId: string | null
  startDate: string | null
  employmentType?: string
}

async function seedCompany(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

async function insertEmployee(seed: { companyId: string; userId: string }, m: Markup): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4,
        employment_start, employment_type, fora_fok_id, fora_fok_start_date)
     VALUES ($1, $2, $3, 'Test', 'Testsson', $4, '0000', '2026-01-01', $5, $6, $7)`,
    // personnummer is unique per company; the ciphertext is never decrypted here.
    [id, seed.companyId, seed.userId, `enc-${id}`, m.employmentType ?? 'employee', m.fokId, m.startDate],
  )
  return id
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

describe('employees Fora markup', () => {
  it('accepts a code with its start date, and no code at all', async () => {
    const seed = await seedCompany()
    const coded = await insertEmployee(seed, { fokId: 'FOK306834', startDate: '2024-01-01' })
    const plain = await insertEmployee(seed, { fokId: null, startDate: null })
    const res = await getPool().query<{ id: string; fora_fok_id: string | null; fora_fok_start_date: string | null }>(
      `SELECT id, fora_fok_id, to_char(fora_fok_start_date, 'YYYY-MM-DD') AS fora_fok_start_date
         FROM public.employees WHERE id = ANY($1)`,
      [[coded, plain]],
    )
    const byId = new Map(res.rows.map((r) => [r.id, r]))
    expect(byId.get(coded)).toMatchObject({ fora_fok_id: 'FOK306834', fora_fok_start_date: '2024-01-01' })
    expect(byId.get(plain)).toMatchObject({ fora_fok_id: null, fora_fok_start_date: null })
  })

  it.each(['FOK12345', 'FOK1234567', 'fok306834', '306834', 'FOK30683A', ' FOK306834'])('rejects the code %j', async (fokId) => {
    const seed = await seedCompany()
    expectRejection(
      await captureError(insertEmployee(seed, { fokId, startDate: '2024-01-01' })),
      'employees_fora_fok_id_format_check',
    )
  })

  it('rejects a code without a start date, and a start date without a code', async () => {
    const seed = await seedCompany()
    expectRejection(
      await captureError(insertEmployee(seed, { fokId: 'FOK306834', startDate: null })),
      'employees_fora_markup_complete_check',
    )
    expectRejection(
      await captureError(insertEmployee(seed, { fokId: null, startDate: '2024-01-01' })),
      'employees_fora_markup_complete_check',
    )
  })

  it.each(['company_owner', 'board_member'])('rejects a code on %s', async (employmentType) => {
    const seed = await seedCompany()
    expectRejection(
      await captureError(insertEmployee(seed, { fokId: 'FOK306834', startDate: '2024-01-01', employmentType })),
      'employees_fora_markup_employee_only_check',
    )
  })

  it('rejects turning a coded employee into an owner, and accepts it with the code cleared', async () => {
    const seed = await seedCompany()
    const id = await insertEmployee(seed, { fokId: 'FOK306834', startDate: '2024-01-01' })
    expectRejection(
      await captureError(
        getPool().query(`UPDATE public.employees SET employment_type = 'company_owner' WHERE id = $1`, [id]),
      ),
      'employees_fora_markup_employee_only_check',
    )
    await getPool().query(
      `UPDATE public.employees
          SET employment_type = 'company_owner', fora_fok_id = NULL, fora_fok_start_date = NULL
        WHERE id = $1`,
      [id],
    )
    const res = await getPool().query<{ employment_type: string }>('SELECT employment_type FROM public.employees WHERE id = $1', [id])
    expect(res.rows[0].employment_type).toBe('company_owner')
  })
})
