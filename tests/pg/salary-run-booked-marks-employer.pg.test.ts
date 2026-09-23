/**
 * pg-real tests for 20260904191000_salary_run_booked_marks_employer.sql.
 *
 * Booking a salary run is evidence that the company pays salaries: the
 * trigger flips company_settings.pays_salaries and fills a never-attested
 * employer_registered, but never overrides an explicit employer answer.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'

async function seed(settings: { paysSalaries?: boolean; employerRegistered?: boolean | null } = {}) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await getPool().query(
    `INSERT INTO public.company_settings (user_id, company_id, pays_salaries, employer_registered)
     VALUES ($1, $2, $3, $4)`,
    [userId, companyId, settings.paysSalaries ?? false, settings.employerRegistered ?? null],
  )
  return { userId, companyId }
}

async function insertRun(companyId: string, userId: string, status: string, month = 6): Promise<string> {
  const runId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
     VALUES ($1, $2, $3, 2026, $4, '2026-06-25', $5)`,
    [runId, companyId, userId, month, status],
  )
  return runId
}

async function readFlags(companyId: string) {
  const { rows } = await getPool().query<{ pays_salaries: boolean; employer_registered: boolean | null }>(
    `SELECT pays_salaries, employer_registered FROM public.company_settings WHERE company_id = $1`,
    [companyId],
  )
  return rows[0]!
}

describe('salary_runs_booked_marks_employer trigger', () => {
  it('leaves the flags at their defaults while the run is a draft', async () => {
    const { companyId, userId } = await seed()
    await insertRun(companyId, userId, 'draft')
    expect(await readFlags(companyId)).toEqual({ pays_salaries: false, employer_registered: null })
  })

  it('marks the company as paying salaries when a run is booked', async () => {
    const { companyId, userId } = await seed()
    const runId = await insertRun(companyId, userId, 'draft')
    await getPool().query(`UPDATE public.salary_runs SET status = 'booked' WHERE id = $1`, [runId])
    expect(await readFlags(companyId)).toEqual({ pays_salaries: true, employer_registered: true })
  })

  it('also fires for a run inserted directly as booked', async () => {
    const { companyId, userId } = await seed()
    await insertRun(companyId, userId, 'booked')
    expect(await readFlags(companyId)).toEqual({ pays_salaries: true, employer_registered: true })
  })

  it('never overrides an explicitly attested employer_registered = false', async () => {
    const { companyId, userId } = await seed({ employerRegistered: false })
    await insertRun(companyId, userId, 'booked')
    expect(await readFlags(companyId)).toEqual({ pays_salaries: true, employer_registered: false })
  })

  it('is a no-op for a company whose flags are already set', async () => {
    const { companyId, userId } = await seed({ paysSalaries: true, employerRegistered: true })
    const before = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    await insertRun(companyId, userId, 'booked')
    const after = await getPool().query<{ updated_at: string }>(
      `SELECT updated_at FROM public.company_settings WHERE company_id = $1`,
      [companyId],
    )
    expect(after.rows[0]!.updated_at).toEqual(before.rows[0]!.updated_at)
  })
})
