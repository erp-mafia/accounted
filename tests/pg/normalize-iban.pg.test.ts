/**
 * In SQL the normalization of an IBAN is public.normalize_iban and nothing
 * else: a body that spells the expression by hand fails here, because two
 * spellings is how the same bank account read as two.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from './setup'
import { insertAuthUser, insertCashAccount, insertCompany, insertCompanyMember } from './fixtures'

const IBAN = 'SE4550000000058398257466'

async function company() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  return companyId
}

describe('public.normalize_iban', () => {
  it('is the one normalization: no spaces, upper case, blank is null', async () => {
    const { rows } = await getPool().query(
      `SELECT public.normalize_iban('se45 5000 0000') AS spaced,
              public.normalize_iban(E'SE45\t5000\n') AS tabbed,
              public.normalize_iban('   ') AS blank,
              public.normalize_iban('') AS empty,
              public.normalize_iban(NULL) AS absent`,
    )
    expect(rows[0]).toEqual({ spaced: 'SE4550000000', tabbed: 'SE455000', blank: null, empty: null, absent: null })
  })

  it('no function spells the expression by hand', async () => {
    const { rows } = await getPool().query<{ fn: string }>(
      `SELECT p.oid::regprocedure::text AS fn
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public'
         AND p.prokind = 'f'
         AND p.proname <> 'normalize_iban'
         AND pg_get_functiondef(p.oid) ~* $1`,
      [`regexp_replace\\([^;]{0,40}iban`],
    )
    expect(rows.map((r) => r.fn)).toEqual([])
  })

  it('a twin plan and a physical key read through it', async () => {
    const companyId = await company()
    await insertCashAccount({ companyId, ledgerAccount: '1930', iban: IBAN, isPrimary: true })
    const id = await insertCashAccount({ companyId, ledgerAccount: '1940', iban: randomUUID().slice(0, 8) })
    await getPool().query(`UPDATE public.cash_accounts SET iban = $2 WHERE id = $1`, [id, 'se45 5000 0000 0583 9825 7466'])
    const { rows } = await getPool().query(`SELECT public.plan_cash_account_twins($1) AS plan`, [companyId])
    expect(JSON.stringify(rows[0].plan)).toContain(`${IBAN}:SEK`)
  }, 30000)
})
