/**
 * pg-real tests for 20260713101000_employee_opening_balances.sql
 * (payroll gap-closure 2.1: cutover state for mid-year migrations).
 *
 * Verifies:
 *   - table exists with RLS enabled + all four company-scoped policies
 *   - RLS isolation: a member of another company sees nothing
 *   - UNIQUE (company_id, employee_id)
 *   - CHECK constraints (ytd_tax <= ytd_gross, karens 0-10)
 *   - the DERIVED lock trigger: writes rejected once the employee has a
 *     BOOKED salary run, and allowed again when that run is corrected
 *     (self-unlocking is the point of deriving instead of flagging).
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

async function insertOpeningBalances(params: {
  companyId: string
  employeeId: string
  ytdGross?: number
  ytdTax?: number
  karens?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employee_opening_balances
       (id, company_id, employee_id, cutover_date, ytd_gross, ytd_tax, ytd_net,
        vacation_paid_days_remaining, vacation_saved_days_by_year,
        opening_semester_liability, opening_semester_liability_avgifter,
        karens_periods_adjustment)
     VALUES ($1, $2, $3, '2026-07-01', $4, $5, 0, 12.5, '{"2025": 5}', 42000, 13196.4, $6)`,
    [id, params.companyId, params.employeeId, params.ytdGross ?? 210000, params.ytdTax ?? 48000, params.karens ?? 1],
  )
  return id
}

async function seedBookedRun(companyId: string, userId: string, employeeId: string): Promise<string> {
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, 7, '2026-07-25', 'booked')`,
    [runId, companyId, userId],
  )
  await getPool().query(
    `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
     VALUES ($1, $2, $3, $4, 'monthly', 35000, 100)`,
    [randomUUID(), runId, employeeId, companyId],
  )
  return runId
}

describe('employee_opening_balances schema', () => {
  it('table exists with RLS enabled and all four policies', async () => {
    const rls = await getPool().query<{ relrowsecurity: boolean }>(
      `SELECT relrowsecurity FROM pg_class WHERE relname = 'employee_opening_balances'`,
    )
    expect(rls.rows).toHaveLength(1)
    expect(rls.rows[0].relrowsecurity).toBe(true)

    const policies = await getPool().query<{ cmd: string }>(
      `SELECT cmd FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'employee_opening_balances'`,
    )
    expect(policies.rows.map((r) => r.cmd).sort()).toEqual(['DELETE', 'INSERT', 'SELECT', 'UPDATE'])
  })

  it('enforces one row per (company_id, employee_id)', async () => {
    const seed = await seedEmployee()
    await insertOpeningBalances(seed)
    await expect(insertOpeningBalances(seed)).rejects.toThrow()
  })

  it('rejects ytd_tax exceeding ytd_gross', async () => {
    const seed = await seedEmployee()
    await expect(
      insertOpeningBalances({ ...seed, ytdGross: 1000, ytdTax: 2000 }),
    ).rejects.toThrow()
  })

  it('rejects karens_periods_adjustment outside 0-10', async () => {
    const seed = await seedEmployee()
    await expect(insertOpeningBalances({ ...seed, karens: 11 })).rejects.toThrow()
  })
})

describe('employee_opening_balances RLS isolation', () => {
  it('members of another company cannot read the row', async () => {
    const a = await seedEmployee()
    await insertOpeningBalances(a)

    const outsider = await insertAuthUser()
    const outsiderCompany = await insertCompany({ createdBy: outsider })
    await insertCompanyMember({ companyId: outsiderCompany, userId: outsider, role: 'owner' })

    const visibleToOwner = await withUserContext(a.userId, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.employee_opening_balances WHERE company_id = $1`,
        [a.companyId],
      )
      return res.rows.length
    })
    expect(visibleToOwner).toBe(1)

    const visibleToOutsider = await withUserContext(outsider, async (client) => {
      const res = await client.query(
        `SELECT id FROM public.employee_opening_balances WHERE company_id = $1`,
        [a.companyId],
      )
      return res.rows.length
    })
    expect(visibleToOutsider).toBe(0)
  })
})

describe('enforce_opening_balances_lock trigger', () => {
  it('blocks INSERT once the employee has a booked run', async () => {
    const seed = await seedEmployee()
    await seedBookedRun(seed.companyId, seed.userId, seed.employeeId)
    await expect(insertOpeningBalances(seed)).rejects.toThrow(/låsta/)
  })

  it('blocks UPDATE once the employee has a booked run', async () => {
    const seed = await seedEmployee()
    const rowId = await insertOpeningBalances(seed)
    await seedBookedRun(seed.companyId, seed.userId, seed.employeeId)

    await expect(
      getPool().query(
        `UPDATE public.employee_opening_balances SET ytd_gross = 999999 WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/låsta/)
  })

  it('self-unlocks when the only booked run is corrected', async () => {
    const seed = await seedEmployee()
    const rowId = await insertOpeningBalances(seed)
    const runId = await seedBookedRun(seed.companyId, seed.userId, seed.employeeId)

    // Locked while booked.
    await expect(
      getPool().query(
        `UPDATE public.employee_opening_balances SET ytd_gross = 250000 WHERE id = $1`,
        [rowId],
      ),
    ).rejects.toThrow(/låsta/)

    // The correction flow flips the run to 'corrected': exactly the moment
    // re-editing opening balances becomes legitimate again.
    await getPool().query(`UPDATE public.salary_runs SET status = 'corrected' WHERE id = $1`, [runId])

    await getPool().query(
      `UPDATE public.employee_opening_balances SET ytd_gross = 250000 WHERE id = $1`,
      [rowId],
    )
    const after = await getPool().query<{ ytd_gross: string }>(
      `SELECT ytd_gross FROM public.employee_opening_balances WHERE id = $1`,
      [rowId],
    )
    expect(Number(after.rows[0].ytd_gross)).toBe(250000)
  })

  it('does not lock on draft or review runs', async () => {
    const seed = await seedEmployee()
    const runId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
       VALUES ($1, $2, $3, 2026, 7, '2026-07-25', 'review')`,
      [runId, seed.companyId, seed.userId],
    )
    await getPool().query(
      `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
       VALUES ($1, $2, $3, $4, 'monthly', 35000, 100)`,
      [randomUUID(), runId, seed.employeeId, seed.companyId],
    )

    // Review runs are still editable payroll state: cutover values may
    // legitimately change before the first booking.
    await insertOpeningBalances(seed)
  })
})
