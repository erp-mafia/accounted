import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  formSettledByOrgNumber,
  readOrgFieldText,
  suggestedFormForOrgNumber,
} from '@/lib/onboarding-journey/org-number-hint'

// Luhn-valid numbers: 802000-0000 style 8-series (förening), 556036-0793 (AB),
// 19850420-1234 is not a legal person (month 04 < 20).
const FORENING = '802481-1658'
const AB = '556036-0793'

describe('suggestedFormForOrgNumber', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('suggests ideell förening for an 8-series juridisk person while the form is creatable', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    expect(suggestedFormForOrgNumber(FORENING)).toBe('ideell_forening')
    expect(suggestedFormForOrgNumber('8024811658')).toBe('ideell_forening')
    expect(suggestedFormForOrgNumber('168024811658')).toBe('ideell_forening')
  })

  it('suggests nothing while the form cannot be created', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    expect(suggestedFormForOrgNumber(FORENING)).toBeNull()
  })

  it('suggests nothing for other series, a personnummer, or an invalid number', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    expect(suggestedFormForOrgNumber(AB)).toBeNull()
    expect(suggestedFormForOrgNumber('19850420-1234')).toBeNull()
    expect(suggestedFormForOrgNumber('802481-1650')).toBeNull()
    expect(suggestedFormForOrgNumber('')).toBeNull()
    expect(suggestedFormForOrgNumber(null)).toBeNull()
  })
})

// A fictional, Luhn-valid personnummer and samordningsnummer (day + 60).
const PERSONNUMMER = '19850420-1230'
const SAMORDNINGSNUMMER = '850480-1237'

describe('formSettledByOrgNumber', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('settles enskild firma for a personnummer in any accepted shape', () => {
    expect(formSettledByOrgNumber(PERSONNUMMER)).toBe('enskild_firma')
    expect(formSettledByOrgNumber('8504201230')).toBe('enskild_firma')
    expect(formSettledByOrgNumber('850420 1230')).toBe('enskild_firma')
    expect(formSettledByOrgNumber(SAMORDNINGSNUMMER)).toBe('enskild_firma')
  })

  it('settles nothing for a juridisk person, whatever forms are creatable', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    expect(formSettledByOrgNumber(AB)).toBeNull()
    expect(formSettledByOrgNumber(FORENING)).toBeNull()
    expect(formSettledByOrgNumber('165560360793')).toBeNull()
  })

  it('settles nothing for an invalid or missing number', () => {
    expect(formSettledByOrgNumber('19850420-1234')).toBeNull()
    expect(formSettledByOrgNumber('')).toBeNull()
    expect(formSettledByOrgNumber(null)).toBeNull()
    expect(formSettledByOrgNumber(undefined)).toBeNull()
  })
})

describe('readOrgFieldText', () => {
  it('reads typographic dashes as the hyphen they stand for', () => {
    expect(readOrgFieldText('850420\u20131230')).toBe('850420-1230')
    expect(readOrgFieldText('19850420\u22121230')).toBe('19850420-1230')
    expect(readOrgFieldText('850420\u20111230')).toBe('850420-1230')
    expect(readOrgFieldText('556036\u20140793')).toBe('556036-0793')
  })

  it('leaves everything else as typed', () => {
    expect(readOrgFieldText('850420-1230')).toBe('850420-1230')
    expect(readOrgFieldText('Nordvik Bygg AB')).toBe('Nordvik Bygg AB')
    expect(readOrgFieldText('')).toBe('')
  })
})
