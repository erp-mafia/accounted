import { describe, it, expect } from 'vitest'
import {
  normalizeLineDimensions,
  lineDimensionColumns,
  coerceDimensionsBag,
  DIM_COST_CENTER,
  DIM_PROJECT,
} from '@/lib/bookkeeping/dimension-resolver'

describe('normalizeLineDimensions', () => {
  it('returns empty map for a line with no dimension data', () => {
    expect(normalizeLineDimensions({})).toEqual({})
    expect(normalizeLineDimensions({ cost_center: null, project: null })).toEqual({})
  })

  it('maps the deprecated aliases to SIE keys 1 and 6', () => {
    expect(normalizeLineDimensions({ cost_center: 'KS01', project: 'P001' })).toEqual({
      '1': 'KS01',
      '6': 'P001',
    })
  })

  it('passes an explicit bag through', () => {
    expect(normalizeLineDimensions({ dimensions: { '1': 'KS01', '7': 'ANST-4' } })).toEqual({
      '1': 'KS01',
      '7': 'ANST-4',
    })
  })

  it('lets the explicit bag win over aliases per key', () => {
    expect(
      normalizeLineDimensions({
        dimensions: { '1': 'KS-BAG' },
        cost_center: 'KS-ALIAS',
        project: 'P-ALIAS',
      })
    ).toEqual({ '1': 'KS-BAG', '6': 'P-ALIAS' })
  })

  it('treats an explicit empty string in the bag as clearing that dimension', () => {
    expect(
      normalizeLineDimensions({ dimensions: { '1': '' }, cost_center: 'KS-ALIAS' })
    ).toEqual({})
  })

  it('trims whitespace and drops blank values', () => {
    expect(
      normalizeLineDimensions({ dimensions: { '6': '  P001  ' }, cost_center: '   ' })
    ).toEqual({ '6': 'P001' })
  })

  it('drops non-numeric and zero/negative keys', () => {
    expect(
      normalizeLineDimensions({
        dimensions: { projekt: 'X', '0': 'Y', '6': 'P001' } as Record<string, string>,
      })
    ).toEqual({ '6': 'P001' })
  })

  it("canonicalizes leading-zero keys ('01' -> '1') so mirrors are derived", () => {
    const dims = normalizeLineDimensions({ dimensions: { '01': 'KS01', '06': 'P001' } })
    expect(dims).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(lineDimensionColumns(dims)).toEqual({ cost_center: 'KS01', project: 'P001' })
  })

  it("clearing via a leading-zero key ('01': '') also clears the alias-filled '1'", () => {
    expect(
      normalizeLineDimensions({ dimensions: { '01': '' }, cost_center: 'KS-ALIAS' })
    ).toEqual({})
  })

  it('reversal parity: empty bag + populated aliases equals alias-only input', () => {
    // reverseEntry passes {dimensions: {}, cost_center, project} for legacy
    // rows; storno passes the row directly — both must normalize identically.
    expect(
      normalizeLineDimensions({ dimensions: {}, cost_center: 'KS01', project: 'P001' })
    ).toEqual(normalizeLineDimensions({ cost_center: 'KS01', project: 'P001' }))
  })
})

describe('coerceDimensionsBag (boundary validator for staged payloads)', () => {
  it('returns undefined for non-objects', () => {
    expect(coerceDimensionsBag(undefined)).toBeUndefined()
    expect(coerceDimensionsBag(null)).toBeUndefined()
    expect(coerceDimensionsBag('P001')).toBeUndefined()
    expect(coerceDimensionsBag(['6', 'P001'])).toBeUndefined()
  })

  it('accepts a valid bag and normalizes values', () => {
    expect(coerceDimensionsBag({ '6': ' P001 ', '1': 'KS01' })).toEqual({
      '6': 'P001',
      '1': 'KS01',
    })
  })

  it('rejects the WHOLE bag on any invalid entry — same as the API schema', () => {
    // Numeric value (no silent coercion), invalid key, leading-zero key:
    // exactly what CreateJournalEntryLineSchema would reject.
    expect(coerceDimensionsBag({ '6': 42 })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 42, '1': 'KS01' })).toBeUndefined()
    expect(coerceDimensionsBag({ projekt: 'P001', '6': 'P001' })).toBeUndefined()
    expect(coerceDimensionsBag({ '06': 'P001' })).toBeUndefined()
  })

  it('enforces the same length/charset constraints as the Zod line schema', () => {
    expect(coerceDimensionsBag({ '6': 'x'.repeat(41) })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 'P"1' })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 'P{1}' })).toBeUndefined()
    expect(coerceDimensionsBag({ '6': 'x'.repeat(40) })).toEqual({ '6': 'x'.repeat(40) })
  })

  it('returns undefined for an empty or whitespace-only bag', () => {
    expect(coerceDimensionsBag({})).toBeUndefined()
  })
})

describe('lineDimensionColumns', () => {
  it('derives both mirrors from the map', () => {
    expect(lineDimensionColumns({ [DIM_COST_CENTER]: 'KS01', [DIM_PROJECT]: 'P001' })).toEqual({
      cost_center: 'KS01',
      project: 'P001',
    })
  })

  it('returns nulls for missing keys', () => {
    expect(lineDimensionColumns({})).toEqual({ cost_center: null, project: null })
    expect(lineDimensionColumns({ '7': 'ANST-4' })).toEqual({ cost_center: null, project: null })
  })

  it('round-trips with normalizeLineDimensions (mirror consistency)', () => {
    const dims = normalizeLineDimensions({ cost_center: 'KS01', dimensions: { '6': 'P001' } })
    expect(lineDimensionColumns(dims)).toEqual({ cost_center: 'KS01', project: 'P001' })
  })
})
