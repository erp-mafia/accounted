import { describe, it, expect } from 'vitest'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'

/**
 * The enskild firma equity block must match the official BAS kontoplan.
 *
 * 2012 "Avräkning för skatter och avgifter" was added in #1388 on the strength
 * of the swedish-year-end-closing skill alone. The primary-source check
 * (#1409, bas.se BAS 2026 v2) shows the official chart has no 2012: the block
 * runs 2010, 2011, 2013, 2017, 2018, 2019, and the official "Avräkning för
 * skatter och avgifter (skattekonto)" accounts are 1630/1640 (asset) and 2850
 * (liability). 2012 is a program convention (Visma, Bokio, Björn Lundén), not
 * standard BAS. A non-standard account in BAS_REFERENCE leaks into every chart
 * the backfill seeds, and from there into SIE export and SRU filing, so the
 * reference must not carry it. Owner taxes paid by the firm are an eget uttag
 * on 2013, which is what the "Preliminär F-skatt (EF)" template books since
 * migration 20260810120000.
 */
describe('enskild firma equity accounts (20xx)', () => {
  it('carries exactly the official BAS block for delägare 1', () => {
    for (const account of ['2010', '2011', '2013', '2017', '2018', '2019']) {
      expect(getBASReference(account), `${account} missing from BAS reference`).toBeDefined()
    }
  })

  it('does not carry 2012: not in official BAS, verified against bas.se in #1409', () => {
    // Pinned like 2113 below: prevents a well-meaning "fix" that re-adds the
    // program-convention account instead of keeping the reference official.
    expect(getBASReference('2012')).toBeUndefined()
  })

  it('keeps the skattekonto asset account the template settles against', () => {
    const skattekonto = getBASReference('1630')
    expect(skattekonto?.account_type).toBe('asset')
  })

  it('shares the equity SRU code across the sub-accounts, since they all net into 2010', () => {
    const siblings = ['2011', '2013', '2018'].map((a) => getBASReference(a)?.sru_code)
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
