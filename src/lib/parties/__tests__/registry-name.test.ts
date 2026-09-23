import { describe, it, expect } from 'vitest'
import { displayNameFromRegistry, sameName } from '../registry-name'

describe('displayNameFromRegistry', () => {
  it('sets an all-capitals registry name in title case and keeps legal forms and acronyms', () => {
    expect(displayNameFromRegistry('WEBHALLEN SVERIGE AB')).toBe('Webhallen Sverige AB')
    expect(displayNameFromRegistry('AKTIEBOLAGET VOLVO')).toBe('Aktiebolaget Volvo')
    expect(displayNameFromRegistry('THE INTELLIGENCE COMPANY AB (PUBL)')).toBe('The Intelligence Company AB (publ)')
    expect(displayNameFromRegistry('SEB KORT BANK AB')).toBe('SEB Kort Bank AB')
    expect(displayNameFromRegistry('SVENSK-DANSKA BYGG HB')).toBe('Svensk-Danska Bygg HB')
    expect(displayNameFromRegistry('FÖRENINGEN FÖR SVENSK MUSIK')).toBe('Föreningen för Svensk Musik')
  })

  it('leaves a name with lowercase letters exactly as written', () => {
    expect(displayNameFromRegistry('The Intelligence Company AB (publ)')).toBe('The Intelligence Company AB (publ)')
    expect(displayNameFromRegistry('Visma Spcs AB')).toBe('Visma Spcs AB')
    expect(displayNameFromRegistry('  Framer  B.V. ')).toBe('Framer B.V.')
  })
})

describe('sameName', () => {
  it('compares names case- and whitespace-insensitively and never matches empties', () => {
    expect(sameName('Visma Spcs AB', 'VISMA SPCS AB')).toBe(true)
    expect(sameName('Webhallen Oktober', 'WEBHALLEN SVERIGE AB')).toBe(false)
    expect(sameName('', '')).toBe(false)
    expect(sameName(null, null)).toBe(false)
  })
})
