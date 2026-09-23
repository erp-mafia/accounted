import { afterEach, describe, expect, it, vi } from 'vitest'
import { suggestedFormForOrgNumber } from '@/lib/onboarding-journey/org-number-hint'

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
