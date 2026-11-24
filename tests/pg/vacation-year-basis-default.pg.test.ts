import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'
import { getClient, getPool } from './setup'

/**
 * company_settings.salary_vacation_year_basis default
 * (20261124191700_new_companies_statutory_vacation_year.sql): a new
 * company's settings row starts on the semesterlagen's semesterår, 1 April
 * to 31 March (3 §), and every row stored before the migration keeps its
 * basis.
 */

const INSERT_SETTINGS = `INSERT INTO public.company_settings (company_id, user_id) VALUES ($1, $2)`
const READ_BASIS = `SELECT salary_vacation_year_basis AS basis FROM public.company_settings WHERE company_id = $1`

async function bareCompany(): Promise<{ userId: string; companyId: string }> {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return { userId, companyId }
}

/** The migration's own SQL, found by name so a re-timestamp keeps the test. */
function migrationSql(): string {
  const dir = join(process.cwd(), 'supabase/migrations')
  const file = readdirSync(dir).filter((f) => f.endsWith('_new_companies_statutory_vacation_year.sql'))
  expect(file).toHaveLength(1)
  return readFileSync(join(dir, file[0]!), 'utf8')
}

describe('company_settings.salary_vacation_year_basis default (pg)', () => {
  it('gives a new settings row the statutory year, 1 April to 31 March', async () => {
    const company = await bareCompany()
    await getPool().query(INSERT_SETTINGS, [company.companyId, company.userId])

    const { rows } = await getPool().query<{ basis: string }>(READ_BASIS, [company.companyId])
    expect(rows).toEqual([{ basis: 'statutory_apr_mar' }])
  })

  it('leaves a row stored before the migration on the calendar year, and only a later row starts statutory', async () => {
    const existing = await bareCompany()
    const created = await bareCompany()
    const client = await getClient()
    try {
      await client.query('BEGIN')
      // The column as it stood before the migration, and a company saved then.
      await client.query(
        `ALTER TABLE public.company_settings ALTER COLUMN salary_vacation_year_basis SET DEFAULT 'calendar'`,
      )
      await client.query(INSERT_SETTINGS, [existing.companyId, existing.userId])
      expect((await client.query(READ_BASIS, [existing.companyId])).rows).toEqual([{ basis: 'calendar' }])

      await client.query(migrationSql())

      expect((await client.query(READ_BASIS, [existing.companyId])).rows).toEqual([{ basis: 'calendar' }])
      await client.query(INSERT_SETTINGS, [created.companyId, created.userId])
      expect((await client.query(READ_BASIS, [created.companyId])).rows).toEqual([{ basis: 'statutory_apr_mar' }])
    } finally {
      await client.query('ROLLBACK')
      client.release()
    }
  })

  it('still stores the calendar year when a company saves it', async () => {
    const company = await bareCompany()
    await getPool().query(
      `INSERT INTO public.company_settings (company_id, user_id, salary_vacation_year_basis) VALUES ($1, $2, 'calendar')`,
      [company.companyId, company.userId],
    )

    const { rows } = await getPool().query<{ basis: string }>(READ_BASIS, [company.companyId])
    expect(rows).toEqual([{ basis: 'calendar' }])
  })
})
