import { describe, expect, it } from 'vitest'
import {
  findSupplierCandidates,
  normalizeSupplierName,
  scoreSupplierName,
} from '../supplier-candidates'

describe('normalizeSupplierName', () => {
  it('lowercases, strips punctuation and legal-form suffixes', () => {
    expect(normalizeSupplierName('Polarn O. Pyret AB')).toBe('polarn o pyret')
    expect(normalizeSupplierName('polarn o pyret')).toBe('polarn o pyret')
    expect(normalizeSupplierName('ECAB Bygg & VVS AB')).toBe('ecab bygg & vvs')
    expect(normalizeSupplierName('Städarna i Uppsala Aktiebolag')).toBe('städarna i uppsala')
  })

  it('only strips the suffix at the end, not inside the name', () => {
    expect(normalizeSupplierName('AB Volvo')).toBe('ab volvo')
    expect(normalizeSupplierName('Habo Snickeri')).toBe('habo snickeri')
  })
})

describe('scoreSupplierName', () => {
  it('scores the Polarn OCR-variant case as an exact normalized match', () => {
    expect(scoreSupplierName('Polarn o Pyret', 'Polarn O. Pyret AB')).toBe(1)
  })

  it('scores containment at 0.9', () => {
    expect(scoreSupplierName('Polarn o Pyret', 'Polarn O Pyret Sverige AB')).toBe(0.9)
  })

  it('scores partial token overlap below containment', () => {
    const s = scoreSupplierName('Bygg & VVS Norr', 'ECAB Bygg & VVS AB')
    expect(s).toBeGreaterThan(0)
    expect(s).toBeLessThan(0.9)
  })

  it('scores unrelated names near zero', () => {
    expect(scoreSupplierName('Polarn o Pyret', 'DNB Bank AB')).toBeLessThan(0.4)
  })
})

describe('findSupplierCandidates', () => {
  const suppliers = [
    { id: 'sup-polarn', name: 'Polarn O. Pyret AB', org_number: '556235-8797' },
    { id: 'sup-dnb', name: 'DNB Bank AB', org_number: '5169077454' },
    { id: 'sup-ecab', name: 'ECAB Bygg & VVS AB', org_number: null },
  ]

  it('matches org numbers across formatting variants at score 1', () => {
    const c = findSupplierCandidates(suppliers, null, '5562358797')
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ supplier_id: 'sup-polarn', score: 1, matched_on: 'org_number' })
  })

  it('surfaces the near-miss name candidate for the Polarn case', () => {
    const c = findSupplierCandidates(suppliers, 'Polarn o Pyret', null)
    expect(c[0]).toMatchObject({ supplier_id: 'sup-polarn', score: 1, matched_on: 'name' })
  })

  it('applies the minScore threshold', () => {
    const c = findSupplierCandidates(suppliers, 'Helt Annat Företagsnamn', null)
    expect(c).toEqual([])
  })

  it('caps the candidate list and sorts by score descending', () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: `sup-${i}`,
      name: `Polarn o Pyret ${i}`,
      org_number: null,
    }))
    const c = findSupplierCandidates(many, 'Polarn o Pyret', null)
    expect(c).toHaveLength(5)
    expect(c.every((x, i, arr) => i === 0 || arr[i - 1].score >= x.score)).toBe(true)
  })

  it('returns empty for no extracted signal', () => {
    expect(findSupplierCandidates(suppliers, null, null)).toEqual([])
  })
})
