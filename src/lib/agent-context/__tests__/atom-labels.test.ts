import { describe, expect, it } from 'vitest'
import { atomLabel } from '../atom-labels'

describe('atomLabel', () => {
  it('names a core atom in Swedish by id, by underscored id, or by its English title', () => {
    expect(atomLabel({ id: 'swedish-vat', title: 'Swedish VAT' })).toBe('Moms')
    expect(atomLabel({ id: 'swedish_year_end_closing', title: 'x' })).toBe('Bokslut')
    expect(atomLabel({ id: 'atom-42', title: 'Swedish Payroll' })).toBe('Lön och arbetsgivaravgifter')
  })

  it('keeps the atom title for anything it does not know', () => {
    expect(atomLabel({ id: 'vertical-bygg', title: 'Bygg & hantverk (SNI 41-43)' })).toBe('Bygg & hantverk (SNI 41-43)')
  })
})
