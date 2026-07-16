/**
 * pg-real tests for 20260713122000_vacation_ledger.sql
 * (payroll gap-closure 3.1: vacation balance ledger + year closures).
 *
 * Verifies:
 *   - both tables exist with RLS enabled
 *   - employee_vacation_balances has all four policies; vacation_year_closures
 *     deliberately has NO DELETE policy (closures are audit artifacts)
 *   - UNIQUE (company_id, employee_id, vacation_year_start) on the ledger
 *   - UNIQUE (company_id, vacation_year_start) on closures (replay -> 409)
 *   - RLS isolation across companies
 *   - company_settings.salary_vacation_year_basis CHECK
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

async function seedEmployee(): Promise<{
  userId: string
  companyId: string
  employeeId: string
}> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })

  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  return { userId, companyId, employeeId }
}

async function insertBalance(params: {
  companyId: string
  employeeId: string
  yearStart?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employee_vacation_balances
       (id, company_id, employee_id, vacation_year_start, entitled_days, taken_days, saved_days)
     VALUES ($1, $2, $3, $4, 25, 3, '{"2025": 5}')`,
    [id, params.companyId, params.employeeId, params.yearStart ?? '2026-01-01'],
  )
  return id
}

describe('employee_vacation_balances schema', () => {
  it('table exists with RLS enabled and all four policies', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'employee_vacation_balances'`,
    )
    expect(rls.rows).toHaveLength(1)
    expect(rls.rows[0].relrowsecurity).toBe(true)

    const policies = await getPool().query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'employee_vacation_balances'`,
    )
    expect(policies.rows.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  it('enforces one row per (company, employee, vacation year)', async () => {
    const seed = await seedEmployee()
    await insertBalance(seed)
    await expect(insertBalance(seed)).rejects.toThrow()
    // A different vacation year is fine.
    await insertBalance({ ...seed, yearStart: '2027-01-01' })
  })

  it('rejects negative day counts and non-object saved_days', async () => {
    const seed = await seedEmployee()
    await expect(
      getPool().query(
        `INSERT INTO public.employee_vacation_balances
           (id, company_id, employee_id, vacation_year_start, entitled_days)
         VALUES ($1, $2, $3, '2026-01-01', -1)`,
        [randomUUID(), seed.companyId, seed.employeeId],
      ),
    ).rejects.toThrow()
    await expect(
      getPool().query(
        `INSERT INTO public.employee_vacation_balances
           (id, company_id, employee_id, vacation_year_start, saved_days)
         VALUES ($1, $2, $3, '2026-01-01', '[]')`,
        [randomUUID(), seed.companyId, seed.employeeId],
      ),
    ).rejects.toThrow()
  })

  it('is isolated per company via RLS', async () => {
    const a = await seedEmployee()
    await insertBalance(a)

    const outsider = await insertAuthUser()
    const outsiderCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: outsiderCompany, userId: outsider, role: 'owner' })

    const visibleToOwner = await withUserContext(a.userId, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.employee_vacation_balances WHERE company_id = $1`,
        [a.companyId],
      )
      return res.rows.length
    })
    expect(visibleToOwner).toBe(1)

    const visibleToOutsider = await withUserContext(outsider, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.employee_vacation_balances WHERE company_id = $1`,
        [a.companyId],
      )
      return res.rows.length
    })
    expect(visibleToOutsider).toBe(0)
  })
})

describe('vacation_year_closures schema', () => {
  it('has SELECT/INSERT/UPDATE policies but deliberately NO DELETE policy', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'vacation_year_closures'`,
    )
    expect(rls.rows[0].relrowsecurity).toBe(true)

    const policies = await getPool().query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'vacation_year_closures'`,
    )
    expect(policies.rows.map((r) => r.cmd).sort()).toEqual(['INSERT', 'SELECT', 'UPDATE'])
  })

  it('enforces one closure per (company, vacation year): the replay anchor', async () => {
    const seed = await seedEmployee()
    const insertClosure = () =>
      getPool().query(
        `INSERT INTO public.vacation_year_closures
           (id, company_id, vacation_year_start, closed_by, report)
         VALUES ($1, $2, '2026-01-01', $3, '{"rows": []}')`,
        [randomUUID(), seed.companyId, seed.userId],
      )
    await insertClosure()
    await expect(insertClosure()).rejects.toThrow()
  })
})

describe('company_settings.salary_vacation_year_basis', () => {
  it('defaults to calendar and rejects unknown values', async () => {
    const seed = await seedEmployee()
    // company_settings row may not exist for a bare fixture company; insert one.
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT (company_id) DO NOTHING`,
      [seed.companyId, seed.userId],
    )
    const row = await getPool().query<{ salary_vacation_year_basis: string }>(
      `SELECT salary_vacation_year_basis FROM public.company_settings WHERE company_id = $1`,
      [seed.companyId],
    )
    expect(row.rows[0].salary_vacation_year_basis).toBe('calendar')

    await expect(
      getPool().query(
        `UPDATE public.company_settings SET salary_vacation_year_basis = 'anniversary' WHERE company_id = $1`,
        [seed.companyId],
      ),
    ).rejects.toThrow()

    await getPool().query(
      `UPDATE public.company_settings SET salary_vacation_year_basis = 'statutory_apr_mar' WHERE company_id = $1`,
      [seed.companyId],
    )
  })
})
