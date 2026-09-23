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
    // Insurance AB, bank AB: not a plain AB, and not a planned form either.
    for (const code of ['42', '41', null]) {
      expect(toCompanySuggestion(candidate({ legalFormCode: code })).legalEntityType).toBeNull()
    }
  })

  it('names the planned forms so the journey can stop on them instead of offering the picker', () => {
    expect(toCompanySuggestion(candidate({ legalFormCode: '51' })).legalEntityType).toBe('Ekonomisk förening')
    expect(toCompanySuggestion(candidate({ legalFormCode: '53' })).legalEntityType).toBe('Bostadsrättsförening')
    expect(toCompanySuggestion(candidate({ legalFormCode: '62' })).legalEntityType).toBe('Samfällighetsförening')
    expect(toCompanySuggestion(candidate({ legalFormCode: '72' })).legalEntityType).toBe('Annan stiftelse')
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
