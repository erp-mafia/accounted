import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { ENTITY_TYPES } from '@/lib/company/entity-type'
import { LEGAL_FORMS } from '@/lib/company/forms'

/**
 * The TypeScript profiles (lib/company/forms/) and the SQL side agree:
 * `supported_entity_types()` lists exactly the forms that have a profile, and
 * the chart `seed_chart_of_accounts` produces for a form contains the equity
 * accounts its profile books to. The prior-year carry account is not asserted
 * here: the AB seed leaves 2098 to the engine, which creates a missing
 * standard account on demand from the BAS reference (a unit test pins that
 * the profile only names reference accounts).
 */

async function accountNumbers(companyId: string): Promise<string[]> {
  const res = await getPool().query<{ account_number: string }>(
    `SELECT account_number FROM public.chart_of_accounts WHERE company_id = $1 ORDER BY account_number`,
    [companyId],
  )
  return res.rows.map((r) => r.account_number)
}

describe('legal form profiles: SQL agrees with the registry', () => {
  it('supported_entity_types() lists exactly the forms that have a profile', async () => {
    const res = await getPool().query<{ list: string[] }>(`SELECT public.supported_entity_types() AS list`)
    expect(res.rows[0].list).toEqual([...ENTITY_TYPES])
  })

  for (const form of ENTITY_TYPES) {
    it(`${form}: the seeded chart carries the profile's closing and settlement accounts`, async () => {
      const userId = await insertAuthUser()
      const companyId = await insertCompany({ createdBy: userId, entityType: form, name: `Profile ${form}` })
      await getPool().query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [companyId, form])
      const numbers = await accountNumbers(companyId)
      const { closing, settlement } = LEGAL_FORMS[form].equity
      for (const expected of new Set([closing, settlement.withdrawal, settlement.contribution])) {
        expect(numbers, `${form}: ${expected} missing from the seeded chart`).toContain(expected)
      }
    })
  }
})
