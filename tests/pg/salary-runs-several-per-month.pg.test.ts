import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20261128090000_salary_runs_several_per_month.sql: one live run per
 * (company, period, run_number). Run number 1 keeps the old one-run-per-period
 * guarantee; an extra run takes 2 and up; a corrected run frees its number for
 * its correction.
 */

async function seed(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  return { userId, companyId }
}

async function insertRun(params: {
  userId: string
  companyId: string
  runNumber?: number
  status?: string
  paymentDate?: string
}): Promise<string> {
  const id = randomUUID()
  const numbered = params.runNumber !== undefined
  await getPool().query(
    `INSERT INTO public.salary_runs
       (id, company_id, user_id, period_year, period_month, payment_date, status${numbered ? ', run_number' : ''})
     VALUES ($1, $2, $3, 2026, 11, $4, $5${numbered ? ', $6' : ''})`,
    [
      id,
      params.companyId,
      params.userId,
      params.paymentDate ?? '2026-11-26',
      params.status ?? 'draft',
      ...(numbered ? [params.runNumber] : []),
    ],
  )
  return id
}

describe('salary_runs.run_number', () => {
  it('defaults to 1 and refuses a number below 1', async () => {
    const { userId, companyId } = await seed()
    const id = await insertRun({ userId, companyId })
    const res = await getPool().query<{ run_number: number }>(`SELECT run_number FROM public.salary_runs WHERE id = $1`, [id])
    expect(res.rows[0].run_number).toBe(1)

    const other = await seed()
    await expect(insertRun({ ...other, runNumber: 0 })).rejects.toMatchObject({ code: '23514' })
  })

  it('keeps one live run per period and number, and lets an extra number in beside it', async () => {
    const { userId, companyId } = await seed()
    await insertRun({ userId, companyId, paymentDate: '2026-11-05' })
    await expect(insertRun({ userId, companyId })).rejects.toMatchObject({ code: '23505' })

    await expect(insertRun({ userId, companyId, runNumber: 2 })).resolves.toBeDefined()
    await expect(insertRun({ userId, companyId, runNumber: 2 })).rejects.toMatchObject({ code: '23505' })
  })

  it('frees a corrected run\'s number for its correction', async () => {
    const { userId, companyId } = await seed()
    const original = await insertRun({ userId, companyId, runNumber: 2 })
    await getPool().query(`UPDATE public.salary_runs SET status = 'corrected' WHERE id = $1`, [original])
    await expect(insertRun({ userId, companyId, runNumber: 2 })).resolves.toBeDefined()
  })
})

describe('agi_declarations.salary_run_ids', () => {
  it('is null unless a declaration lists the runs it covers', async () => {
    const res = await getPool().query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'agi_declarations' AND column_name = 'salary_run_ids'`,
    )
    expect(res.rows[0]).toEqual({ data_type: 'ARRAY', is_nullable: 'YES' })
  })
})
