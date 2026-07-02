import { describe, it, expect } from 'vitest'
import {
  normalizeLineDimensions,
  lineDimensionColumns,
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
