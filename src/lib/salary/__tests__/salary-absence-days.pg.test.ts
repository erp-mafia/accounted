import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool, withUserContext } from '@/tests/pg/setup'

/**
 * RLS smoke for salary_absence_days. Sjuklöneperiod / återinsjuknande /
 * högriskskydd derivation already has unit coverage; this test only locks
 * in tenant isolation, which mocked Supabase clients can't exercise.
 */

async function insertEmployee(params: {
  userId: string
  companyId: string
}): Promise<string> {
  const id = randomUUID()
  // personnummer must be 12 digits; last4 mirrors the last four chars.
  const pnr = '199001011234'
  await getPool().query(
    `INSERT INTO public.employees
       (id, user_id, company_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start, monthly_salary, tax_table_number)
     VALUES ($1, $2, $3, 'Test', 'Person', $4, '1234', '2026-01-01', 30000, 32)`,
    [id, params.userId, params.companyId, pnr],
  )
  return id
}

async function insertAbsenceDay(params: {
  companyId: string
  employeeId: string
  date: string
  type?: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.salary_absence_days
       (id, company_id, employee_id, absence_date, absence_type, hours)
     VALUES ($1, $2, $3, $4, $5, 8)`,
    [id, params.companyId, params.employeeId, params.date, params.type ?? 'sick'],
  )
  return id
}

describe('salary_absence_days.pg: RLS tenant isolation', () => {
  it('a user only sees absence days for their own company', async () => {
    const a = await seedCompany()
    const b = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    const empB = await insertEmployee({ userId: b.userId, companyId: b.companyId })
    await insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-15' })
    await insertAbsenceDay({ companyId: b.companyId, employeeId: empB, date: '2026-04-16' })

    const rowsA = await withUserContext(a.userId, async (client) => {
      const res = await client.query<{ company_id: string }>(
        `SELECT company_id FROM public.salary_absence_days`,
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
          `INSERT INTO public.salary_absence_days
             (company_id, employee_id, absence_date, absence_type, hours)
           VALUES ($1, $2, '2026-04-17', 'sick', 8)`,
          [b.companyId, empB],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('enforces unique (employee_id, absence_date, absence_type)', async () => {
    const a = await seedCompany()
    const empA = await insertEmployee({ userId: a.userId, companyId: a.companyId })
    await insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-15' })
    await expect(
      insertAbsenceDay({ companyId: a.companyId, employeeId: empA, date: '2026-04-15' }),
    ).rejects.toThrow(/duplicate key|unique/i)
  })
})
