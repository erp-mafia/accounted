import { describe, expect, it } from 'vitest'
import {
  UNIT_MAX_LENGTH,
  UNIT_NAMES,
  UNIT_SUGGESTIONS,
  isUnitSuggestion,
  normalizeCustomUnit,
  unitName,
  unitPickerOptions,
} from '@/lib/invoices/units'
import { UNIT_CODES } from '@/lib/invoices/peppol-bis-billing'
import { unitLabel } from '@/lib/invoices/unit-labels'

// Units whose code is the same word in English, so unitLabel passes them
// through on an English invoice.
const INTERNATIONAL_UNITS = new Set(['km', 'kg', 'm', 'l', 'm3'])

describe('UNIT_SUGGESTIONS', () => {
  it('offers liter, the unit issue #2611 was about', () => {
    expect(UNIT_SUGGESTIONS).toContain('l')
  })

  it('keeps the units the editors offered before the list grew', () => {
    // Removing one would silently change what every editor suggests.
    for (const unit of ['st', 'tim', 'dag', 'månad', 'km', 'kg', 'l']) {
      expect(UNIT_SUGGESTIONS).toContain(unit)
    }
  })

  it('opens with the most used units', () => {
    expect(UNIT_SUGGESTIONS.slice(0, 3)).toEqual(['st', 'tim', 'dag'])
  })

  it('offers length, area, volume and longer periods', () => {
    for (const unit of ['m', 'kvm', 'm3', 'vecka', 'år']) {
      expect(UNIT_SUGGESTIONS).toContain(unit)
    }
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
    expect(UNIT_CODES.m).toBe('MTR')
    expect(UNIT_CODES.kvm).toBe('MTK')
    expect(UNIT_CODES.m3).toBe('MTQ')
    expect(UNIT_CODES.vecka).toBe('WEE')
    expect(UNIT_CODES['år']).toBe('ANN')
  })

  it('renders on an English invoice without leaking a Swedish word', () => {
    // unitLabel translates what it knows and prints the rest verbatim; a
    // suggested unit that is a Swedish word must have an English label.
    for (const unit of UNIT_SUGGESTIONS) {
      const label = unitLabel(unit, 'en')
      expect(label.length).toBeGreaterThan(0)
      if (INTERNATIONAL_UNITS.has(unit)) {
        expect(label).toBe(unit)
      } else {
        expect(label, `"${unit}" prints untranslated on an English invoice`).not.toBe(unit)
      }
    }
  })
})

describe('UNIT_NAMES and unitName', () => {
  it('names every suggested unit in both languages', () => {
    for (const unit of UNIT_SUGGESTIONS) {
      expect(UNIT_NAMES[unit].sv.length, `no Swedish name for "${unit}"`).toBeGreaterThan(0)
      expect(UNIT_NAMES[unit].en.length, `no English name for "${unit}"`).toBeGreaterThan(0)
    }
  })

  it('prints the plain Swedish name beside the code', () => {
    expect(unitName('st', 'sv')).toBe('styck')
    expect(unitName('tim', 'sv')).toBe('timmar')
    expect(unitName('månad', 'sv')).toBe('månader')
    expect(unitName('l', 'sv')).toBe('liter')
    expect(unitName('kvm', 'sv')).toBe('kvadratmeter')
  })

  it('follows the interface language', () => {
    expect(unitName('st', 'en')).toBe('pieces')
    expect(unitName('kvm', 'en')).toBe('square metres')
    // Any locale that is not English reads Swedish, the product default.
    expect(unitName('st', 'de')).toBe('styck')
  })

  it('prints nothing when the name only repeats the code', () => {
    expect(unitName('år', 'sv')).toBeNull()
    expect(unitName('år', 'en')).toBe('years')
  })

  it('prints nothing for a unit we do not suggest', () => {
    expect(unitName('pkt', 'sv')).toBeNull()
    expect(unitName('', 'sv')).toBeNull()
    expect(unitName('ST', 'sv')).toBeNull()
  })

  it('recognises only exact suggested codes', () => {
    expect(isUnitSuggestion('st')).toBe(true)
    expect(isUnitSuggestion(' st')).toBe(false)
    expect(isUnitSuggestion('St')).toBe(false)
  })
})

describe('unitPickerOptions', () => {
  it('lists every suggestion for a field holding a suggested unit', () => {
    // The datalist this replaced filtered by the field's value, so a row
    // holding "st" only ever offered "st".
    expect(unitPickerOptions('st')).toEqual([...UNIT_SUGGESTIONS])
    expect(unitPickerOptions('l')).toEqual([...UNIT_SUGGESTIONS])
  })

  it('lists every suggestion for an empty field', () => {
    expect(unitPickerOptions('')).toEqual([...UNIT_SUGGESTIONS])
    expect(unitPickerOptions(null)).toEqual([...UNIT_SUGGESTIONS])
    expect(unitPickerOptions(undefined)).toEqual([...UNIT_SUGGESTIONS])
    expect(unitPickerOptions('   ')).toEqual([...UNIT_SUGGESTIONS])
  })

  it('puts a stored unit we do not suggest first, so it shows as current', () => {
    expect(unitPickerOptions('pkt')).toEqual(['pkt', ...UNIT_SUGGESTIONS])
    expect(unitPickerOptions(' pkt ')).toEqual(['pkt', ...UNIT_SUGGESTIONS])
  })

  it('keeps an earlier custom unit pickable after switching away', () => {
    expect(unitPickerOptions('st', ['pkt'])).toEqual(['pkt', ...UNIT_SUGGESTIONS])
    expect(unitPickerOptions('förp', ['pkt'])).toEqual(['förp', 'pkt', ...UNIT_SUGGESTIONS])
  })

  it('never lists a unit twice', () => {
    expect(unitPickerOptions('pkt', ['pkt', 'st', ''])).toEqual(['pkt', ...UNIT_SUGGESTIONS])
  })
})

describe('normalizeCustomUnit', () => {
  it('trims and collapses whitespace', () => {
    expect(normalizeCustomUnit('  rulle ')).toBe('rulle')
    expect(normalizeCustomUnit('per   person')).toBe('per person')
  })

  it('returns empty for blank input, so nothing is committed', () => {
    expect(normalizeCustomUnit('')).toBe('')
    expect(normalizeCustomUnit('   ')).toBe('')
  })

  it('caps the length the API accepts', () => {
    const long = 'x'.repeat(UNIT_MAX_LENGTH + 10)
    expect(normalizeCustomUnit(long)).toHaveLength(UNIT_MAX_LENGTH)
  })
})
