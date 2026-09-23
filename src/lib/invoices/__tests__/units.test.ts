import { describe, expect, it } from 'vitest'
import {
  UNIT_DATALIST_ID,
  UNIT_MAX_LENGTH,
  UNIT_SUGGESTIONS,
} from '@/lib/invoices/units'
import { UNIT_CODES } from '@/lib/invoices/peppol-bis-billing'
import { unitLabel } from '@/lib/invoices/unit-labels'

describe('UNIT_SUGGESTIONS', () => {
  it('offers liter, the unit issue #2611 was about', () => {
    expect(UNIT_SUGGESTIONS).toContain('l')
  })

  it('keeps the units the editors offered before the list was shared', () => {
    // Removing one would silently change what every editor suggests.
    expect(UNIT_SUGGESTIONS).toEqual(['st', 'tim', 'dag', 'månad', 'km', 'kg', 'l'])
  })

  it('has no duplicates and no stray whitespace', () => {
    expect(new Set(UNIT_SUGGESTIONS).size).toBe(UNIT_SUGGESTIONS.length)
    for (const unit of UNIT_SUGGESTIONS) {
      expect(unit).toBe(unit.trim())
      expect(unit.length).toBeGreaterThan(0)
    }
  })

  it('fits the length the API accepts', () => {
    expect(UNIT_MAX_LENGTH).toBe(32)
    for (const unit of UNIT_SUGGESTIONS) {
      expect(unit.length).toBeLessThanOrEqual(UNIT_MAX_LENGTH)
    }
  })

  it('exports every suggested unit through Peppol', () => {
    // A unit we suggest but cannot map to a UN/ECE Rec 20 code would sail
    // through the editor and then fail the e-invoice with UNIT_UNSUPPORTED.
    for (const unit of UNIT_SUGGESTIONS) {
      expect(UNIT_CODES[unit], `no Peppol unit code for "${unit}"`).toBeTruthy()
    }
    expect(UNIT_CODES.l).toBe('LTR')
  })

  it('renders on an English invoice without leaking a Swedish word', () => {
    // unitLabel translates what it knows and prints the rest verbatim; a
    // suggested unit must never print as an untranslated Swedish word.
    for (const unit of UNIT_SUGGESTIONS) {
      const label = unitLabel(unit, 'en')
      expect(label.length).toBeGreaterThan(0)
      expect(label).not.toBe('månad')
    }
    expect(unitLabel('l', 'en')).toBe('l')
  })

  it('names the datalist the inputs point at', () => {
    expect(UNIT_DATALIST_ID).toBe('unit-suggestions')
  })
})
