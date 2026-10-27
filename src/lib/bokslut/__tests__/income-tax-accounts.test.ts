/**
 * The income-tax accounts the bolagsskatt and periodiseringsfond base adds
 * back are the ones INK2 adds back on 4.3a (INK2R 3.25, SRU 7528): one
 * definition, read from the INK2 mapping.
 */
import { describe, expect, it } from 'vitest'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'
import { incomeTaxInResult, isIncomeTaxAccount } from '../tax-provision/income-tax-accounts'

describe('isIncomeTaxAccount', () => {
  it('agrees with the INK2 mapping for Skatt på årets resultat on every 88xx-89xx account', () => {
    const mapping = INK2R_ACCOUNT_MAPPINGS.find((m) => m.sruCode === '7528')!
    for (let n = 8800; n <= 8999; n += 1) {
      const account = String(n)
      expect(isIncomeTaxAccount(account), account).toBe(isAccountInMapping(account, mapping))
    }
  })

  it('covers 8910, 8920, 8930, 8940 and 8980, not årets resultat or bokslutsdispositioner', () => {
    for (const account of ['8910', '8920', '8930', '8940', '8980']) expect(isIncomeTaxAccount(account)).toBe(true)
    for (const account of ['8990', '8999', '8811', '8819', '8850']) expect(isIncomeTaxAccount(account)).toBe(false)
  })
})

describe('incomeTaxInResult', () => {
  const section = (rows: Array<[string, number]>) => ({
    title: 'Skatter och årets resultat',
    rows: rows.map(([account_number, amount]) => ({ account_number, account_name: '', amount })),
    subtotal: rows.reduce((sum, [, amount]) => sum + amount, 0),
  })

  it('is the signed net of the income-tax rows: expense positive, tax income negative', () => {
    // Financial rows are credit - debit.
    expect(
      incomeTaxInResult({
        financial_sections: [section([['8910', -30_000], ['8940', -10_000.5], ['8930', 4_000], ['8811', -1_000]])],
      }),
    ).toBe(36_000.5)
  })

  it('is 0 without income-tax rows or sections', () => {
    expect(incomeTaxInResult({ financial_sections: [section([['8811', -1_000]])] })).toBe(0)
    expect(incomeTaxInResult({ financial_sections: [] })).toBe(0)
    expect(incomeTaxInResult({} as never)).toBe(0)
  })
})
