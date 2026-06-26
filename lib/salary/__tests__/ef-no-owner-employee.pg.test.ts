import { randomUUID } from 'crypto'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Locks in the enforce_ef_no_owner_employee trigger (migration
 * 20260628120000): an enskild firma may employ staff, but never put its owner
 * or board on payroll (owner compensation is egna uttag, not lön). Ordinary
 * employees stay allowed for every entity type. See #782.
 *
 * Inserts go through getPool() (superuser, bypasses RLS) — this exercises the
 * trigger, not tenant isolation.
 */

async function insertEmployee(params: {
  userId: string
  companyId: string
  employmentType: string
}): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.employees
       (id, user_id, company_id, first_name, last_name, personnummer,
        personnummer_last4, employment_start, employment_type, monthly_salary,
        tax_table_number)
     VALUES ($1, $2, $3, 'Test', 'Person', '199001011234', '1234',
             '2026-01-01', $4, 30000, 32)`,
    [id, params.userId, params.companyId, params.employmentType],
  )
  return id
}

describe('enforce_ef_no_owner_employee.pg — owner/board payroll blocked for EF', () => {
  it('rejects company_owner for an enskild firma', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await expect(
      insertEmployee({ userId, companyId, employmentType: 'company_owner' }),
    ).rejects.toThrow(/kan inte ha sin ägare/i)
  })

  it('rejects board_member for an enskild firma', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await expect(
      insertEmployee({ userId, companyId, employmentType: 'board_member' }),
    ).rejects.toThrow(/kan inte ha sin ägare/i)
  })

  it('allows ordinary employees for an enskild firma', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await expect(
      insertEmployee({ userId, companyId, employmentType: 'employee' }),
    ).resolves.not.toThrow()
  })

  it('allows company_owner for an aktiebolag', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
    await expect(
      insertEmployee({ userId, companyId, employmentType: 'company_owner' }),
    ).resolves.not.toThrow()
  })

  it('uses company_settings.entity_type over companies (settings is read-primary)', async () => {
    const userId = await insertAuthUser()
    // companies says aktiebolag, but the user re-classified to EF in settings.
    const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
    await getPool().query(
      `INSERT INTO public.company_settings (user_id, company_id, entity_type)
       VALUES ($1, $2, 'enskild_firma')`,
      [userId, companyId],
    )
    await expect(
      insertEmployee({ userId, companyId, employmentType: 'company_owner' }),
    ).rejects.toThrow(/kan inte ha sin ägare/i)
  })
})

describe('enforce_ef_no_owner_employee.pg — UPDATE semantics', () => {
  it('rejects changing an EF employee to company_owner', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    const empId = await insertEmployee({ userId, companyId, employmentType: 'employee' })
    await expect(
      getPool().query(
        `UPDATE public.employees SET employment_type = 'company_owner' WHERE id = $1`,
        [empId],
      ),
    ).rejects.toThrow(/kan inte ha sin ägare/i)
  })

  it('allows unrelated edits to an EF employee (trigger fires only on employment_type)', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    const empId = await insertEmployee({ userId, companyId, employmentType: 'employee' })
    await expect(
      getPool().query(
        `UPDATE public.employees SET monthly_salary = 42000 WHERE id = $1`,
        [empId],
      ),
    ).resolves.not.toThrow()
  })

  it('allows changing an aktiebolag employee to company_owner', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'aktiebolag' })
    const empId = await insertEmployee({ userId, companyId, employmentType: 'employee' })
    await expect(
      getPool().query(
        `UPDATE public.employees SET employment_type = 'company_owner' WHERE id = $1`,
        [empId],
      ),
    ).resolves.not.toThrow()
  })
})
