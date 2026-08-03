import { describe, it, expect } from 'vitest'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * The enskild firma equity block must be complete.
 *
 * 2012 was missing from the reference, which is not cosmetic:
 * `lib/bookkeeping/account-backfill.ts` only seeds accounts that appear in
 * BAS_REFERENCE, so an account absent from it can never be added to a company's
 * chart on demand. Any entry touching 2012 failed with AccountsNotInChartError,
 * which is exactly what the "Preliminär F-skatt (EF)" template did.
 *
 * The gap was found by the pack validator asserting that every account a
 * template references exists in BAS 2026.
 */
describe('enskild firma equity accounts (20xx)', () => {
  it('has no hole in the 2010-2013 run', () => {
    for (const account of ['2010', '2011', '2012', '2013']) {
      expect(getBASReference(account), `${account} missing from BAS reference`).toBeDefined()
    }
  })

  it('2012 is the owner-tax equity account, distinct from the 1630 skattekonto asset', () => {
    const equity = getBASReference('2012')
    const skattekonto = getBASReference('1630')

    expect(equity?.account_type).toBe('equity')
    expect(equity?.normal_balance).toBe('debit')
    // Both are called "avräkning", which is precisely why they get confused.
    expect(skattekonto?.account_type).toBe('asset')
    expect(equity?.account_number).not.toBe(skattekonto?.account_number)
  })

  it('shares the equity SRU code with its siblings, since they all net into 2010', () => {
    const siblings = ['2011', '2012', '2013', '2018'].map((a) => getBASReference(a)?.sru_code)
    expect(new Set(siblings).size).toBe(1)
    expect(siblings[0]).toBe(getBASReference('2010')?.sru_code)
  })
})

describe('periodiseringsfond accounts', () => {
  it('offers the generic account plus the year-tagged block', () => {
    expect(getBASReference('2110')?.account_name).toContain('Periodiseringsfond')
    // 2120-2129 are year-tagged (2126 = tax year 2026).
    expect(getBASReference('2126')?.account_name).toContain('2026')
  })

  it('does not carry 2113: the pre-2020 year-tagged funds are long reversed', () => {
    // The seeded "Periodiseringsfond" templates referenced 2113 (tax year 2013),
    // so they could never resolve. Pinning this prevents a well-meaning
    // "fix" that re-adds an obsolete account instead of correcting the template.
    expect(getBASReference('2113')).toBeUndefined()
  })
})
