import { describe, expect, it } from 'vitest'
import { BANK_GUIDE_URLS, bankGuideUrl, bankHelpKey, bankPrerequisiteKey, bankSelectable, bankSigningApproach, isTwoStepBank, orderBanks, resolveBankByName } from '../bank-help'

describe('bankPrerequisiteKey', () => {
  it('keeps the prerequisites that prevent a failed BankID visible and leaves Svea’s process note to the help', () => {
    expect(bankPrerequisiteKey({ name: 'Handelsbanken', bic: 'HANDSESS' })).toBe('handelsbanken')
    expect(bankPrerequisiteKey({ name: 'Nordea', bic: 'NDEASESS' })).toBe('nordea')
    expect(bankPrerequisiteKey({ name: 'Sparbanken Nord', bic: 'SWEDSESS' })).toBe('swedbank')
    expect(bankPrerequisiteKey({ name: 'Svea Bank', bic: 'SVEASESS' })).toBeNull()
    expect(bankPrerequisiteKey({ name: 'SEB', bic: 'ESSESESS' })).toBeNull()
  })
})

describe('bankGuideUrl', () => {
  it('renders nothing while the map is empty and finds a film by BIC when one exists', () => {
    expect(Object.keys(BANK_GUIDE_URLS)).toHaveLength(0)
    expect(bankGuideUrl({ bic: 'SWEDSESS' })).toBeNull()
    const films = { SWEDSESS: 'https://example.se/swedbank-1-min' }
    expect(bankGuideUrl({ bic: 'SWEDSESS' }, films)).toBe('https://example.se/swedbank-1-min')
    expect(bankGuideUrl({ bic: 'swedsess' }, films)).toBe('https://example.se/swedbank-1-min')
    expect(bankGuideUrl({ bic: 'ESSESESS' }, films)).toBeNull()
  })
})

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

describe('isTwoStepBank, bankSigningApproach and bankSelectable', () => {
  it('Svea confirms the accounts with a second BankID; a bank is chosen when we can sign at it one way or the other', () => {
    expect(isTwoStepBank({ name: 'Svea Bank', bic: 'SVEASESS' })).toBe(true)
    expect(isTwoStepBank({ name: 'SEB', bic: 'ESSESESS' })).toBe(false)
    expect(bankSigningApproach({ decoupled: true, redirect: false })).toBe('decoupled')
    expect(bankSigningApproach({ decoupled: true, redirect: true })).toBe('both')
    expect(bankSigningApproach({ decoupled: false, redirect: true })).toBe('redirect')
    expect(bankSigningApproach({ decoupled: false, redirect: false })).toBe('none')
    expect(bankSigningApproach({ decoupled: false, redirect: null })).toBe('none')
    // Svea comes with nulls and counts as our screen until its details say otherwise.
    expect(bankSigningApproach({ decoupled: null, redirect: null })).toBe('decoupled')
    expect(bankSelectable({ decoupled: false, redirect: true })).toBe(true)
    expect(bankSelectable({ decoupled: false, redirect: false })).toBe(false)
    expect(bankSelectable({ decoupled: null, redirect: null })).toBe(true)
  })
})

describe('resolveBankByName', () => {
  it('finds a row\'s bank in the list by name, and a sparbank through Swedbank', () => {
    const banks = [{ bic: 'SWEDSESS', name: 'Swedbank' }, { bic: 'ESSESESS', name: 'SEB' }, { bic: 'NDEASESS', name: 'Nordea Bank Abp, filial i Sverige' }]
    expect(resolveBankByName(banks, 'swedbank ')?.bic).toBe('SWEDSESS')
    expect(resolveBankByName(banks, 'Nordea')?.bic).toBe('NDEASESS')
    expect(resolveBankByName(banks, 'Sparbanken Nord')?.bic).toBe('SWEDSESS')
    expect(resolveBankByName(banks, 'Ölands Bank')?.bic).toBe('SWEDSESS')
    expect(resolveBankByName(banks, 'Lunar')).toBeNull()
    expect(resolveBankByName(banks, '')).toBeNull()
  })
})

describe('orderBanks', () => {
  it('lists the common banks first, then the rest alphabetically', () => {
    const names = orderBanks([{ name: 'Ålandsbanken' }, { name: 'Nordea' }, { name: 'Avanza' }, { name: 'Swedbank' }, { name: 'SEB' }]).map((b) => b.name)
    expect(names).toEqual(['Swedbank', 'SEB', 'Nordea', 'Avanza', 'Ålandsbanken'])
  })
})
