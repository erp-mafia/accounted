import { describe, expect, it } from 'vitest'
import { insertAuthUser, insertCompany, seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'

/**
 * Locks in the labels seed_chart_of_accounts() writes for the 26xx output VAT
 * accounts. Per BAS 2026: 2611=25%, 2621=12%, 2631=6%.
 *
 * Background: this mapping has regressed once already (2026-03-30 multi-tenant
 * refactor copy-pasted the original 2024 buggy seed back in). The engine and
 * the VAT-rutor mapping both route by account number, so a mislabel in this
 * function never breaks any other test: only the chart-of-accounts UI shows
 * the wrong text. This test is the canary.
 *
 * The diacritic + SRU groups below cover the 2026-05-16 migration that
 * restored å/ä/ö in account names and started populating sru_code from BAS
 * reference. Both are bytes-on-disk concerns the engine never reads but the
 * UI and tax-filing exports do.
 */

interface AccountRow {
  account_number: string
  account_name: string
  sru_code: string | null
}

async function callSeed(
  companyId: string,
  entityType: 'aktiebolag' | 'enskild_firma',
): Promise<void> {
  await getPool().query(
    `SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`,
    [companyId, entityType],
  )
}

async function getAccounts(companyId: string): Promise<AccountRow[]> {
  const res = await getPool().query<AccountRow>(
    `SELECT account_number, account_name, sru_code
       FROM public.chart_of_accounts
      WHERE company_id = $1
      ORDER BY account_number`,
    [companyId],
  )
  return res.rows
}

describe('seed_chart_of_accounts', () => {
  it('seeds 26xx VAT accounts with BAS-correct labels', async () => {
    const { companyId } = await seedCompany()
    const pool = getPool()

    await pool.query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'aktiebolag',
    ])

    const { rows } = await pool.query<{ account_number: string; account_name: string }>(
      `SELECT account_number, account_name
         FROM public.chart_of_accounts
        WHERE company_id = $1
          AND account_number IN ('2611', '2621', '2631')
        ORDER BY account_number`,
      [companyId],
    )

    const byNumber = Object.fromEntries(rows.map((r) => [r.account_number, r.account_name]))

    expect(byNumber['2611']).toBeDefined()
    expect(byNumber['2611']).toMatch(/25\s*%/)
    expect(byNumber['2611']).toMatch(/[Uu]tg.*moms/)

    expect(byNumber['2621']).toBeDefined()
    expect(byNumber['2621']).toMatch(/12\s*%/)

    expect(byNumber['2631']).toBeDefined()
    expect(byNumber['2631']).toMatch(/6\s*%/)
  })

  it('seeds the input VAT account 2641', async () => {
    const { companyId } = await seedCompany()
    const pool = getPool()

    await pool.query(`SELECT public.seed_chart_of_accounts($1::uuid, $2::text)`, [
      companyId,
      'aktiebolag',
    ])

    const { rows } = await pool.query<{ account_name: string }>(
      `SELECT account_name FROM public.chart_of_accounts
        WHERE company_id = $1 AND account_number = '2641'`,
      [companyId],
    )

    expect(rows).toHaveLength(1)
    expect(rows[0].account_name).toMatch(/[Ii]ng.*moms/)
  })
})

describe('seed_chart_of_accounts: Swedish characters', () => {
  it('inserts Swedish-character account names byte-for-byte for aktiebolag', async () => {
    const { companyId } = await seedCompany()
    await callSeed(companyId, 'aktiebolag')
    const byNum = new Map((await getAccounts(companyId)).map((r) => [r.account_number, r]))

    // Spot-check every row whose name contains å/ä/ö/Å/Ä/Ö. If diacritics
    // were stripped during insertion these assertions are the ones that
    // would fail.
    const expected: Record<string, string> = {
      '1930': 'Företagskonto / checkkonto',
      '1940': 'Övriga bankkonton',
      '2099': 'Årets resultat',
      '2440': 'Leverantörsskulder',
      '2611': 'Utgående moms försäljning inom Sverige, 25%',
      '2621': 'Utgående moms försäljning inom Sverige, 12%',
      '2631': 'Utgående moms försäljning inom Sverige,  6%',
      '2641': 'Debiterad ingående moms',
      '2650': 'Redovisningskonto för moms',
      '2731': 'Avräkning socialavgifter',
      '2893': 'Skuld till aktieägare',
      '3001': 'Försäljning tjänster 25%',
      '3002': 'Försäljning varor 25%',
      '3100': 'Momsfri försäljning',
      '3900': 'Övriga rörelseintäkter',
      '4000': 'Varuinköp',
      '5410': 'Förbrukningsinventarier',
      '5460': 'Förbrukningsmaterial',
      '6530': 'Redovisningstjänster',
      '6991': 'Övriga avdragsgilla kostnader',
      '7010': 'Löner',
      '7210': 'Semesterlöner',
      '7960': 'Valutakursförluster',
      '8310': 'Ränteintäkter',
      '8410': 'Räntekostnader',
    }

    for (const [num, name] of Object.entries(expected)) {
      const row = byNum.get(num)
      expect(row, `account ${num} should be seeded`).toBeDefined()
      expect(row!.account_name, `account ${num} name`).toBe(name)
    }
  })

  it('inserts Swedish-character account names for enskild_firma equity accounts', async () => {
    // seedCompany() defaults to aktiebolag, so go direct for the EF case.
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId, entityType: 'enskild_firma' })
    await callSeed(companyId, 'enskild_firma')
    const byNum = new Map((await getAccounts(companyId)).map((r) => [r.account_number, r]))

    expect(byNum.get('2013')?.account_name).toBe('Övriga egna uttag')
    expect(byNum.get('2018')?.account_name).toBe('Övriga egna insättningar')

    // AB-only equity accounts must not appear for enskild_firma.
    expect(byNum.has('2081')).toBe(false)
    expect(byNum.has('2091')).toBe(false)
    expect(byNum.has('2099')).toBe(false)

    // EF equity accounts must NOT carry the AB-oriented INK2 SRU code 7221.
    // EF entities file NE-bilaga instead of INK2; emitting `#SRU 2013 7221`
    // in a SIE export would steer downstream tax software to report owner
    // drawings as balance-sheet equity, which is wrong for sole traders.
    expect(byNum.get('2010')?.sru_code).toBeNull()
    expect(byNum.get('2013')?.sru_code).toBeNull()
    expect(byNum.get('2018')?.sru_code).toBeNull()
  })

  it('stores diacritics as multi-byte UTF-8, not as ASCII folds', async () => {
    // octet_length > char_length holds only when the string contains
    // multi-byte UTF-8 code units. If a future regression strips å/ä/ö
    // again the lengths would become equal and this fails loudly.
    const { companyId } = await seedCompany()
    await callSeed(companyId, 'aktiebolag')
    const res = await getPool().query<{
      account_number: string
      octets: number
      chars: number
    }>(
      `SELECT account_number,
              octet_length(account_name) AS octets,
              char_length(account_name)  AS chars
         FROM public.chart_of_accounts
        WHERE company_id = $1
          AND account_number IN ('2099', '2440', '2611', '2731', '7010', '8410')`,
      [companyId],
    )
    expect(res.rows.length).toBe(6)
    for (const row of res.rows) {
      expect(
        row.octets,
        `account ${row.account_number}: octet_length must exceed char_length`,
      ).toBeGreaterThan(row.chars)
    }
  })
})

describe('seed_chart_of_accounts: SRU codes', () => {
  it('populates sru_code for every seeded account so the K1 chart can produce SRU/INK2 filings', async () => {
    const { companyId } = await seedCompany()
    await callSeed(companyId, 'aktiebolag')
    const rows = await getAccounts(companyId)

    const missing = rows.filter((r) => r.sru_code === null)
    expect(
      missing,
      `every seeded row must have sru_code populated. Missing: ${missing
        .map((r) => `${r.account_number} (${r.account_name})`)
        .join(', ')}`,
    ).toHaveLength(0)
  })

  it('maps representative accounts to the SRU codes from BAS reference', async () => {
    const { companyId } = await seedCompany()
    await callSeed(companyId, 'aktiebolag')
    const byNum = new Map((await getAccounts(companyId)).map((r) => [r.account_number, r]))

    // Spot-check values pulled from lib/bookkeeping/bas-data/. These three
    // map to Skatteverket SRU fields in INK2; getting them wrong would
    // silently break tax filing.
    expect(byNum.get('2099')?.sru_code).toBe('7222')
    expect(byNum.get('2611')?.sru_code).toBe('7231')
    expect(byNum.get('2731')?.sru_code).toBe('7231')
    expect(byNum.get('1930')?.sru_code).toBe('7212')
    expect(byNum.get('3001')?.sru_code).toBe('7310')
    expect(byNum.get('7010')?.sru_code).toBe('7322')
  })
})

describe('seed_chart_of_accounts: invariants', () => {
  it('is idempotent: a second call on a company that already has accounts is a no-op', async () => {
    const { companyId } = await seedCompany()
    await callSeed(companyId, 'aktiebolag')
    const firstCount = (await getAccounts(companyId)).length

    await callSeed(companyId, 'aktiebolag')
    const secondCount = (await getAccounts(companyId)).length

    expect(secondCount).toBe(firstCount)
  })

  it('seeds plan_type=k1 and is_system_account=true on every starter account', async () => {
    // These two flags are what the SIE importer's existing-account
    // short-circuit relies on to distinguish seeded rows from imported
    // ones. Drifting away from them would change the importer's
    // behaviour for existing companies silently.
    const { companyId } = await seedCompany()
    await callSeed(companyId, 'aktiebolag')
    const res = await getPool().query<{ bad_plan: number; bad_flag: number }>(
      `SELECT
         count(*) FILTER (WHERE plan_type IS DISTINCT FROM 'k1')::int      AS bad_plan,
         count(*) FILTER (WHERE is_system_account IS DISTINCT FROM true)::int AS bad_flag
       FROM public.chart_of_accounts
       WHERE company_id = $1`,
      [companyId],
    )
    expect(res.rows[0]!.bad_plan).toBe(0)
    expect(res.rows[0]!.bad_flag).toBe(0)
  })
})
