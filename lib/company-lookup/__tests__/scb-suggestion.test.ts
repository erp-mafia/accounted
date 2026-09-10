import { describe, it, expect } from 'vitest'
import { toCompanySuggestion } from '../scb-suggestion'
import type { ScbCandidate } from '@/lib/parties/scb/client'

const candidate = (over: Partial<ScbCandidate> = {}): ScbCandidate => ({
  orgNumber: '5566778899',
  name: 'Testbrand AB',
  city: 'Malmö',
  industry: null,
  legalForm: 'Aktiebolag',
  legalFormCode: '49',
  status: 'Är verksam',
  active: true,
  ...over,
})

describe('toCompanySuggestion', () => {
  it('maps the forms the journey sets up and leaves the rest to the user', () => {
    expect(toCompanySuggestion(candidate()).legalEntityType).toBe('AB')
    expect(toCompanySuggestion(candidate({ legalFormCode: '10' })).legalEntityType).toBe('EF')
    expect(toCompanySuggestion(candidate({ legalFormCode: '61' })).legalEntityType).toBe('Ideell förening')
    // Insurance AB, bank AB, ekonomisk förening, stiftelse: not a plain AB.
    for (const code of ['42', '41', '51', '72', null]) {
      expect(toCompanySuggestion(candidate({ legalFormCode: code })).legalEntityType).toBeNull()
    }
  })

  it('carries only what the picker shows plus the number it resolves to', () => {
    expect(toCompanySuggestion(candidate({ active: false }))).toEqual({
      orgNumber: '5566778899',
      name: 'Testbrand AB',
      city: 'Malmö',
      legalEntityType: 'AB',
      active: false,
    })
  })
})
