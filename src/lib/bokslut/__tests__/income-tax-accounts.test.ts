/**
 * The income-tax accounts the bolagsskatt and periodiseringsfond base adds
 * back are the ones INK2 adds back on 4.3a (INK2R 3.25, SRU 7528): one
 * definition, read from the INK2 mapping.
 */
import { describe, expect, it } from 'vitest'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'
import { isIncomeTaxAccount } from '../tax-provision/income-tax-accounts'

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
