import { describe, expect, it } from 'vitest'
import { BANK_GUIDE_URLS, bankGuideUrl, bankHelpKey, bankPrerequisiteKey, bankSelectable, bankSigningApproach, isTwoStepBank, orderBanks, resolveBankByName } from '../bank-help'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'

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
  it('links each bank with a guide at Open Payments, case-insensitively by BIC, and nothing for a bank without one', () => {
    expect(bankGuideUrl({ bic: 'SWEDSESS' })).toBe('https://www.openpayments.io/integrera/swedbank-psd2')
    expect(bankGuideUrl({ bic: 'handsess' })).toBe('https://www.openpayments.io/integrera/handelsbanken-psd2')
    expect(bankGuideUrl({ bic: 'ELLFSESS' })).toBeNull()
    for (const url of Object.values(BANK_GUIDE_URLS)) expect(url).toMatch(/^https:\/\/www\.openpayments\.io\/integrera\/[a-z-]+-psd2$/)
    const films = { SWEDSESS: 'https://example.se/swedbank-1-min' }
    expect(bankGuideUrl({ bic: 'SWEDSESS' }, films)).toBe('https://example.se/swedbank-1-min')
    expect(bankGuideUrl({ bic: 'swedsess' }, films)).toBe('https://example.se/swedbank-1-min')
    expect(bankGuideUrl({ bic: 'ESSESESS' }, films)).toBeNull()
  })

  it('names the link a guide and promises no films, which most of those pages lack (crm#1686)', () => {
    for (const messages of [sv, en]) {
      const label = messages.bank_connect.guide_link
      expect(label).toContain('{bank}')
      expect(label).toMatch(/guide/i)
      expect(label).not.toMatch(/film|video/i)
    }
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

  it('signs Svea on its own page now that Connect\'s entry says redirect only (Open Payments support, 2026-10-14)', () => {
    expect(bankSigningApproach({ decoupled: false, redirect: true })).toBe('redirect')
    expect(bankSelectable({ decoupled: false, redirect: true })).toBe(true)
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
