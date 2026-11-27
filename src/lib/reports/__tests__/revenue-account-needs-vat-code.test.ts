import { describe, expect, it } from 'vitest'
import { revenueAccountNeedsVatCode, revenueAccountsWithoutRuta } from '../vat-declaration'

const account = (
  account_number: string,
  account_name: string,
  over: { default_vat_rate?: number | null; default_vat_treatment?: string | null; account_class?: number } = {},
) => ({ account_number, account_name, default_vat_rate: null, default_vat_treatment: null, ...over })

describe('revenueAccountNeedsVatCode', () => {
  it('needs nothing for an account a ruta sums by its number', () => {
    expect(revenueAccountNeedsVatCode(account('3001', 'Försäljning inom Sverige, 25 % moms'))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3000', 'Försäljning inom Sverige'))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3004', 'Försäljning inom Sverige, momsfri'))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3308', 'Försäljning tjänster till annat EU-land'))).toBe(false)
  })

  it('needs nothing where the number and the name give the momssats, or one is set', () => {
    expect(revenueAccountNeedsVatCode(account('3011', 'Försäljning varor, 25 % moms'))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3540', 'Faktureringsavgifter', { default_vat_rate: 0.25 }))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3040', 'Konsulttjänster', { default_vat_treatment: 'standard_25' }))).toBe(false)
  })

  it('needs nothing for the accounts that carry no omsättning', () => {
    expect(revenueAccountNeedsVatCode(account('3740', 'Öres- och kronutjämning'))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3960', 'Valutakursvinster'))).toBe(false)
  })

  it('needs a momskod on a revenue account nothing places', () => {
    expect(revenueAccountNeedsVatCode(account('3040', 'Konsulttjänster'))).toBe(true)
    expect(revenueAccountNeedsVatCode(account('3540', 'Faktureringsavgifter'))).toBe(true)
    // A rate in the name alone is not read outside the 30x1, 30x2, 30x3 pattern.
    expect(revenueAccountNeedsVatCode(account('3540', 'Faktureringsavgifter 25 % moms'))).toBe(true)
  })

  it('is only about class 3', () => {
    expect(revenueAccountNeedsVatCode(account('4010', 'Inköp material'))).toBe(false)
    expect(revenueAccountNeedsVatCode(account('3040', 'Konsulttjänster', { account_class: 4 }))).toBe(false)
  })

  it('agrees with the warning the declaration gives for a period', () => {
    const names = new Map([
      ['3001', 'Försäljning inom Sverige, 25 % moms'],
      ['3040', 'Konsulttjänster'],
      ['3740', 'Öres- och kronutjämning'],
    ])
    const totals = new Map([...names.keys()].map((number) => [number, { debit: 0, credit: 1000 }]))
    const warned = revenueAccountsWithoutRuta(totals, { unconfiguredRevenueAccounts: names }).map((row) => row.account_number)
    const needing = [...names].filter(([number, name]) => revenueAccountNeedsVatCode(account(number, name))).map(([number]) => number)
    expect(warned).toEqual(['3040'])
    expect(needing).toEqual(warned)
  })
})
