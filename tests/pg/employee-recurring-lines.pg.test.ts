import { randomUUID } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

// pg-real coverage for 20260831210000_employee_recurring_lines: RLS (member
// read, stranger blind, viewer read-only), the composite employee/company FK
// (cross-company insert refused), the CHECKs (deduction-only item types,
// negative amount, period order, account format) and the NO ACTION back-link
// FK from salary_line_items (delete of a derived-into line fails with 23503).

async function seedEmployee(): Promise<{ userId: string; companyId: string; employeeId: string }> {
  const { userId, companyId } = await seedCompany()
  const employeeId = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, company_id, user_id, first_name, last_name, personnummer, personnummer_last4, employment_start)
     VALUES ($1, $2, $3, 'Test', 'Testsson', 'enc-payload', '0000', '2026-01-01')`,
    [employeeId, companyId, userId],
  )
  return { userId, companyId, employeeId }
}

async function insertLine(
  companyId: string,
  employeeId: string,
  userId: string,
  overrides: Partial<{ itemType: string; amount: number; validTo: string | null; account: string | null }> = {},
): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employee_recurring_lines
       (id, employee_id, company_id, user_id, item_type, description, amount, account_number, valid_from, valid_to)
     VALUES ($1, $2, $3, $4, $5, 'Förmånscykel bruttolöneavdrag', $6, $7, '2026-01-01', $8)`,
    [
      id,
      employeeId,
      companyId,
      userId,
      overrides.itemType ?? 'gross_deduction_other',
      overrides.amount ?? -670.17,
      overrides.account ?? null,
      overrides.validTo === undefined ? null : overrides.validTo,
    ],
  )
  return id
}

describe('employee_recurring_lines RLS', () => {
  it('lets company members read, strangers see nothing', async () => {
    const { userId, companyId, employeeId } = await seedEmployee()
    const lineId = await insertLine(companyId, employeeId, userId)
    const stranger = await insertAuthUser()

    const memberView = await withUserContext(userId, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.employee_recurring_lines WHERE id = $1`, [lineId]),
    )
    expect(memberView.rows).toHaveLength(1)

    const strangerView = await withUserContext(stranger, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.employee_recurring_lines WHERE id = $1`, [lineId]),
    )
    expect(strangerView.rows).toHaveLength(0)
  })

  it('members read their company, non-members cannot write', async () => {
    // Policies are company-scoped like employee_benefits (the mirrored
    // precedent): viewer write-blocking is enforced app-side by requireWrite,
    // not in RLS, so the DB assertion here is membership, not role.
    const { userId, companyId, employeeId } = await seedEmployee()
    const lineId = await insertLine(companyId, employeeId, userId)
    const viewer = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewer, role: 'viewer' })

    const viewerRead = await withUserContext(viewer, (client) =>
      client.query<{ id: string }>(`SELECT id FROM public.employee_recurring_lines WHERE id = $1`, [lineId]),
    )
    expect(viewerRead.rows).toHaveLength(1)

    const stranger = await insertAuthUser()
    await expect(
      withUserContext(stranger, (client) =>
        client.query(
          `INSERT INTO public.employee_recurring_lines
             (employee_id, company_id, user_id, item_type, description, amount, valid_from)
           VALUES ($1, $2, $3, 'net_deduction_union', 'Fackavgift', -100, '2026-01-01')`,
          [employeeId, companyId, stranger],
        ),
      ),
    ).rejects.toThrow(/row-level security/)

    const upd = await withUserContext(stranger, (client) =>
      client.query(`UPDATE public.employee_recurring_lines SET amount = -1 WHERE id = $1`, [lineId]),
    )
    expect(upd.rowCount).toBe(0)
    const del = await withUserContext(stranger, (client) =>
      client.query(`DELETE FROM public.employee_recurring_lines WHERE id = $1`, [lineId]),
    )
    expect(del.rowCount).toBe(0)
  })

  it('the composite FK refuses pointing a line at another company employee', async () => {
    const a = await seedEmployee()
    const b = await seedEmployee()

    // Insert as superuser (bypasses RLS): the composite (employee_id,
    // company_id) FK is what must refuse the cross-company pair.
    await expect(
      getPool().query(
        `INSERT INTO public.employee_recurring_lines
           (employee_id, company_id, user_id, item_type, description, amount, valid_from)
         VALUES ($1, $2, $3, 'gross_deduction_other', 'IDOR', -100, '2026-01-01')`,
        [b.employeeId, a.companyId, a.userId],
      ),
    ).rejects.toThrow(/foreign key/)
  })
})

describe('employee_recurring_lines constraints', () => {
  it('rejects non-deduction item types (other) and positive amounts', async () => {
    const { userId, companyId, employeeId } = await seedEmployee()
    await expect(
      insertLine(companyId, employeeId, userId, { itemType: 'other', amount: -500 }),
    ).rejects.toThrow(/item_type/)
    await expect(
      insertLine(companyId, employeeId, userId, { amount: 500 }),
    ).rejects.toThrow(/amount_sign/)
  })

  it('rejects valid_to before valid_from and malformed account overrides', async () => {
    const { userId, companyId, employeeId } = await seedEmployee()
    await expect(
      insertLine(companyId, employeeId, userId, { validTo: '2025-12-31' }),
    ).rejects.toThrow(/check constraint/i)
    await expect(
      insertLine(companyId, employeeId, userId, { account: '73' }),
    ).rejects.toThrow(/account_format/)
  })
})

describe('salary_line_items back-link FK', () => {
  it('NO ACTION blocks deleting a line that has been derived into a run', async () => {
    const { userId, companyId, employeeId } = await seedEmployee()
    const lineId = await insertLine(companyId, employeeId, userId)

    const runId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_runs (id, company_id, user_id, period_year, period_month, payment_date, status)
       VALUES ($1, $2, $3, 2026, 8, '2026-08-25', 'draft')`,
      [runId, companyId, userId],
    )
    const sreId = randomUUID()
    await getPool().query(
      `INSERT INTO public.salary_run_employees (id, salary_run_id, employee_id, company_id, salary_type, monthly_salary, employment_degree)
       VALUES ($1, $2, $3, $4, 'monthly', 35000, 100)`,
      [sreId, runId, employeeId, companyId],
    )
    await getPool().query(
      `INSERT INTO public.salary_line_items
         (id, salary_run_employee_id, company_id, item_type, description, quantity, amount,
          is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction, source_recurring_line_id)
       VALUES ($1, $2, $3, 'gross_deduction_other', 'Förmånscykel bruttolöneavdrag', 1, -670.17,
               true, true, false, true, false, $4)`,
      [randomUUID(), sreId, companyId, lineId],
    )

    await expect(
      getPool().query(`DELETE FROM public.employee_recurring_lines WHERE id = $1`, [lineId]),
    ).rejects.toThrow(/foreign key/)

    // Deactivation (the DELETE route's fallback) still works.
    const deactivate = await getPool().query(
      `UPDATE public.employee_recurring_lines SET is_active = false WHERE id = $1`,
      [lineId],
    )
    expect(deactivate.rowCount).toBe(1)
  })
})
