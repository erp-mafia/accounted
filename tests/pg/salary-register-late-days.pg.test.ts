import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * 20261125183000_salary_register_late_days.sql: a register day known after
 * its run was paid or declared is carried to a later run
 * (carried_to_run_id, lib/salary/late-days.ts). The database keeps the link
 * inside the company and refuses to delete a run late days still point at,
 * so a day is never left deducted by no run.
 */

interface Seed {
  userId: string
  companyId: string
  employeeId: string
  octoberId: string
  novemberId: string
}

async function seed(): Promise<Seed> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  const octoberId = randomUUID()
  const novemberId = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_runs
       (id, company_id, user_id, period_year, period_month, payment_date, status,
        deviation_period_start, deviation_period_end)
     VALUES ($1, $3, $4, 2026, 10, '2026-10-23', 'booked', '2026-10-01', '2026-10-31'),
            ($2, $3, $4, 2026, 11, '2026-11-25', 'draft', '2026-11-01', '2026-11-30')`,
    [octoberId, novemberId, companyId, userId],
  )
  return { userId, companyId, employeeId, octoberId, novemberId }
}

function insertAbsence(s: Pick<Seed, 'companyId' | 'employeeId'>, date: string, carriedTo: string | null) {
  return getPool().query<{ id: string; franvaro_specifikationsnummer: number | null }>(
    `INSERT INTO public.salary_absence_days (company_id, employee_id, absence_date, absence_type, hours, carried_to_run_id)
     VALUES ($1, $2, $3, 'parental', 8, $4)
     RETURNING id, franvaro_specifikationsnummer`,
    [s.companyId, s.employeeId, date, carriedTo],
  )
}

function insertWorked(s: Pick<Seed, 'companyId' | 'employeeId'>, date: string, carriedTo: string | null) {
  return getPool().query(
    `INSERT INTO public.salary_worked_days (company_id, employee_id, work_date, hours, carried_to_run_id)
     VALUES ($1, $2, $3, 8, $4)`,
    [s.companyId, s.employeeId, date, carriedTo],
  )
}

describe('carried_to_run_id on the absence and worked-days registers', () => {
  it('is a nullable column with a composite NO ACTION foreign key to the run of the same company', async () => {
    const { rows } = await getPool().query<{ table: string; nullable: string }>(
      `SELECT table_name AS table, is_nullable AS nullable
         FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'carried_to_run_id'
          AND table_name IN ('salary_absence_days', 'salary_worked_days')
        ORDER BY table_name`,
    )
    expect(rows).toEqual([
      { table: 'salary_absence_days', nullable: 'YES' },
      { table: 'salary_worked_days', nullable: 'YES' },
    ])
    const fks = await getPool().query<{ conname: string; confdeltype: string; def: string }>(
      `SELECT conname, confdeltype, pg_get_constraintdef(oid) AS def
         FROM pg_constraint
        WHERE conname IN ('salary_absence_days_carried_to_run_fkey', 'salary_worked_days_carried_to_run_fkey')
        ORDER BY conname`,
    )
    // 'a' = NO ACTION: a delete of the run is refused while late days point at it.
    expect(fks.rows.map((r) => [r.conname, r.confdeltype])).toEqual([
      ['salary_absence_days_carried_to_run_fkey', 'a'],
      ['salary_worked_days_carried_to_run_fkey', 'a'],
    ])
    for (const fk of fks.rows) {
      expect(fk.def).toBe('FOREIGN KEY (carried_to_run_id, company_id) REFERENCES salary_runs(id, company_id)')
    }
  })

  it('stores a day with no carry, as every day before', async () => {
    const s = await seed()
    const { rows } = await insertAbsence(s, '2026-11-02', null)
    expect(rows).toHaveLength(1)
    await insertWorked(s, '2026-11-02', null)
  })

  it('carries a late October day to November and still numbers its frånvarouppgift in October', async () => {
    const s = await seed()
    const first = await insertAbsence(s, '2026-10-19', s.novemberId)
    const second = await insertAbsence(s, '2026-10-20', s.novemberId)
    // The FK822 bucket is the absence date's month, carried or not.
    expect([first.rows[0].franvaro_specifikationsnummer, second.rows[0].franvaro_specifikationsnummer]).toEqual([1, 2])
    await insertWorked(s, '2026-10-19', s.novemberId)
  })

  it("refuses a carry to another company's run", async () => {
    const s = await seed()
    const other = await seed()
    await expect(insertAbsence(s, '2026-10-19', other.novemberId)).rejects.toMatchObject({ code: '23503' })
    await expect(insertWorked(s, '2026-10-19', other.novemberId)).rejects.toMatchObject({ code: '23503' })
  })

  it('refuses a carry to a run that does not exist', async () => {
    const s = await seed()
    await expect(insertAbsence(s, '2026-10-19', randomUUID())).rejects.toMatchObject({ code: '23503' })
  })

  it('refuses to delete the run late days are carried to, naming the constraint the app maps', async () => {
    const s = await seed()
    await insertAbsence(s, '2026-10-19', s.novemberId)
    await expect(
      getPool().query(`DELETE FROM public.salary_runs WHERE id = $1`, [s.novemberId]),
    ).rejects.toMatchObject({
      code: '23503',
      message: expect.stringContaining('salary_absence_days_carried_to_run_fkey'),
    })

    const worked = await seed()
    await insertWorked(worked, '2026-10-19', worked.novemberId)
    await expect(
      getPool().query(`DELETE FROM public.salary_runs WHERE id = $1`, [worked.novemberId]),
    ).rejects.toMatchObject({ code: '23503', message: expect.stringContaining('salary_worked_days_carried_to_run_fkey') })
  })

  it('deletes the run once its late days are gone', async () => {
    const s = await seed()
    const day = await insertAbsence(s, '2026-10-19', s.novemberId)
    await getPool().query(`DELETE FROM public.salary_absence_days WHERE id = $1`, [day.rows[0].id])
    const res = await getPool().query(`DELETE FROM public.salary_runs WHERE id = $1`, [s.novemberId])
    expect(res.rowCount).toBe(1)
  })
})
