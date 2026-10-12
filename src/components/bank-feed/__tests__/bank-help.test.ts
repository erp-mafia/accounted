import { describe, expect, it } from 'vitest'
import { bankHelpKey, bankSelectable, isTwoStepBank, orderBanks } from '../bank-help'

describe('bankHelpKey', () => {
  it('names the prerequisite for the banks we know and none for the rest', () => {
    expect(bankHelpKey({ name: 'Handelsbanken', bic: 'HANDSESS' })).toBe('handelsbanken')
    expect(bankHelpKey({ name: 'Nordea Bank Abp', bic: 'NDEASESS' })).toBe('nordea')
    expect(bankHelpKey({ name: 'Swedbank', bic: 'SWEDSESS' })).toBe('swedbank')
    expect(bankHelpKey({ name: 'Sparbanken Skåne', bic: 'SWEDSESS' })).toBe('swedbank')
    expect(bankHelpKey({ name: 'Svea Bank', bic: 'SVEASESS' })).toBe('svea')
    expect(bankHelpKey({ name: 'Bokio Företagskonto', bic: 'SVEASESS' })).toBe('svea')
    expect(bankHelpKey({ name: 'SEB', bic: 'ESSESESS' })).toBeNull()
  })
})

describe('isTwoStepBank and bankSelectable', () => {
  it('Svea confirms the accounts with a second BankID; a redirect-only bank cannot be chosen yet', () => {
    expect(isTwoStepBank({ name: 'Svea Bank', bic: 'SVEASESS' })).toBe(true)
    expect(isTwoStepBank({ name: 'SEB', bic: 'ESSESESS' })).toBe(false)
    expect(bankSelectable({ decoupled: false })).toBe(false)
    expect(bankSelectable({ decoupled: true })).toBe(true)
    // Svea comes with nulls and is still selectable.
    expect(bankSelectable({ decoupled: null })).toBe(true)
  })
})

describe('orderBanks', () => {
  it('lists the common banks first, then the rest alphabetically', () => {
    const names = orderBanks([{ name: 'Ålandsbanken' }, { name: 'Nordea' }, { name: 'Avanza' }, { name: 'Swedbank' }, { name: 'SEB' }]).map((b) => b.name)
    expect(names).toEqual(['Swedbank', 'SEB', 'Nordea', 'Avanza', 'Ålandsbanken'])
  })
})
