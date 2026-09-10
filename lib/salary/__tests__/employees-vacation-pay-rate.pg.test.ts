import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * employees.vacation_pay_rate CHECK (migration 20260910162348): a
 * kollektivavtal semesterlön rate is a fraction between the statutory floor
 * (0.12) and 0.30; NULL means statutory. Below the floor is illegal under
 * Semesterlagen 16 b §, above 0.30 is a unit typo (13.5 entered raw).
 */

async function insertEmployee(params: {
  userId: string
  companyId: string
  vacationPayRate: number | null
}): Promise<string> {
  const id = randomUUID()
  // Synthetic 12-digit personnummer, unique per row (personnummer is unique
  // per company); last4 mirrors the last four chars.
  const pnr = `19900101${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`
  await getPool().query(
    `INSERT INTO public.employees
       (id, user_id, company_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start, monthly_salary, tax_table_number,
        vacation_pay_rate)
     VALUES ($1, $2, $3, 'Test', 'Person', $4, $5, '2026-01-01', 30000, 32, $6)`,
    [id, params.userId, params.companyId, pnr, pnr.slice(-4), params.vacationPayRate],
  )
  return id
}

describe('employees.vacation_pay_rate.pg: CHECK bounds', () => {
  it('accepts NULL (statutory) and a kollektivavtal rate inside the bounds', async () => {
    const { userId, companyId } = await seedCompany()
    const nullId = await insertEmployee({ userId, companyId, vacationPayRate: null })
    const cbaId = await insertEmployee({ userId, companyId, vacationPayRate: 0.135 })

    const res = await getPool().query<{ id: string; vacation_pay_rate: string | null }>(
      `SELECT id, vacation_pay_rate FROM public.employees WHERE id = ANY($1::uuid[]) ORDER BY vacation_pay_rate NULLS FIRST`,
      [[nullId, cbaId]],
    )
    expect(res.rows).toHaveLength(2)
    expect(res.rows[0].vacation_pay_rate).toBeNull()
    expect(Number(res.rows[1].vacation_pay_rate)).toBe(0.135)
  })

  it('rejects a rate below the statutory floor', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertEmployee({ userId, companyId, vacationPayRate: 0.1 })).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('rejects a percentage entered raw (13.5 instead of 0.135)', async () => {
    const { userId, companyId } = await seedCompany()
    await expect(insertEmployee({ userId, companyId, vacationPayRate: 13.5 })).rejects.toMatchObject({
      code: '23514',
    })
  })

  it('accepts clearing back to NULL on update', async () => {
    const { userId, companyId } = await seedCompany()
    const id = await insertEmployee({ userId, companyId, vacationPayRate: 0.13 })
    await getPool().query(`UPDATE public.employees SET vacation_pay_rate = NULL WHERE id = $1`, [id])
    const res = await getPool().query<{ vacation_pay_rate: string | null }>(
      `SELECT vacation_pay_rate FROM public.employees WHERE id = $1`,
      [id],
    )
    expect(res.rows[0].vacation_pay_rate).toBeNull()
  })
})
