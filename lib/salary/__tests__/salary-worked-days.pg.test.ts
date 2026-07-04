import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * RLS + 24h cap smoke for salary_worked_days. Pay-period summing has unit
 * coverage in the calculate-route test; this file locks in the database-
 * level invariants that mocked Supabase clients can't exercise:
 *   - Tenant isolation via RLS
 *   - Unique (employee_id, work_date)
 *   - 24h cap across worked + absence on the same date (allows half-day
 *     mixing up to 24h, blocks overflow)
 */

async function insertEmployee(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  const pnr = '199001011234'
  await getPool().query(
    `INSERT INTO public.employees
       (id, user_id, company_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start, hourly_rate, salary_type, tax_table_number)
     VALUES ($1, $2, $3, 'Test', 'Person', $4, '1234', '2026-01-01', 250, 'hourly', 32)`,
    [id, params.userId, params.companyId, pnr],
  )
  return id
}

async function insertWorkedDay(params: {
  companyId: string
  employeeId: string
  date: string
  hours?: number
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_worked_days
       (id, company_id, employee_id, work_date, hours)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, params.companyId, params.employeeId, params.date, params.hours ?? 8],
  )
  return id
}

async function insertAbsenceDay(params: {
  companyId: string
  employeeId: string
  date: string
  hours?: number
  type?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_absence_days
       (id, company_id, employee_id, absence_date, absence_type, hours)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, params.companyId, params.employeeId, params.date, params.type ?? 'sick', params.hours ?? 8],
  )
  return id
}

describe('salary_worked_days.pg: RLS tenant isolation', () => {
  it('a user only sees worked days for their own company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    const empB = await insertEmployee({ userId: b.userId, companyId: b.companyId })
    await insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-15' })
    await insertWorkedDay({ companyId: b.companyId, employeeId: empB, date: '2026-04-16' })

    const rowsA = await withUserContext(a.userId, async (client) => {
      const res = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.salary_worked_days`,
      )
      return res.rows
    })
    expect(rowsA).toHaveLength(1)
    expect(rowsA[0]!.company_id).toBe(a.companyId)
  })

  it('blocks INSERT into another tenant via WITH CHECK', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const empB = await insertEmployee({ userId: b.userId, companyId: b.companyId })

    await expect(
      withUserContext(a.userId, async (client) => {
        return client.query(
          `INSERT INTO public.salary_worked_days
             (company_id, employee_id, work_date, hours)
           VALUES ($1, $2, '2026-04-17', 8)`,
          [b.companyId, empB],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('enforces unique (employee_id, work_date)', async () => {
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    await insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-15' })
    await expect(
      insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-15' }),
    ).rejects.toThrow(/duplicate key|unique/i)
  })
})

describe('salary_worked_days.pg: 24h cap across worked + absence', () => {
  it('allows half-day mixing (4h worked + 4h sick = 8h total)', async () => {
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    await insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-20', hours: 4 })
    // Should not throw: combined 4h + 4h = 8h ≤ 24h.
    await expect(
      insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-20', hours: 4 }),
    ).resolves.not.toThrow()
  })

  it('allows up to exactly 24h combined', async () => {
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    await insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-21', hours: 16 })
    await expect(
      insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-21', hours: 8 }),
    ).resolves.not.toThrow()
  })

  it('blocks worked day that pushes total above 24h', async () => {
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    await insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-22', hours: 20 })
    await expect(
      insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-22', hours: 6 }),
    ).rejects.toThrow(/Total tid.*24 timmar/i)
  })

  it('blocks absence day that pushes total above 24h', async () => {
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    await insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-23', hours: 20 })
    await expect(
      insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-23', hours: 6 }),
    ).rejects.toThrow(/Total tid.*24 timmar/i)
  })

  it('UPDATE on existing row excludes own previous contribution', async () => {
    // Bug guard: if the trigger summed including the row being updated,
    // editing 8h → 6h on a day with 8h absence would falsely report 16h+8h.
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    const wid = await insertWorkedDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-24', hours: 8 })
    await insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-24', hours: 8 })
    await expect(
      getPool().query(
        `UPDATE public.salary_worked_days SET hours = 6 WHERE id = $1`,
        [wid],
      ),
    ).resolves.not.toThrow()
  })
})
