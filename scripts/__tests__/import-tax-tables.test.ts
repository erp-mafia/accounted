import { describe, it, expect } from 'vitest'
import { parseLine } from '../import-tax-tables'

// Build a fixed-width SKV 434 record: prefix(5) income_from(7) income_to(7)
// then six 5-char columns = 49 chars.
function record(prefix: string, from: string, to: string, cols: string[] = ['100', '200', '300', '400', '500', '600']): string {
  return prefix + from.padStart(7) + to.padStart(7) + cols.map((c) => c.padStart(5)).join('')
}

describe('parseLine', () => {
  it('parses a monthly B-row', () => {
    const parsed = parseLine(record('30B29', '20001', '20200'))
    expect(parsed).toEqual({
      table: 29,
      row: [20001, 20200, 100, 200, 300, 400, 500, 600, 0],
    })
  })

  it('parses a monthly percent row with a blank open-ended upper bound', () => {
    const parsed = parseLine(record('30%29', '80001', '', ['32', '30', '32', '28', '33', '34']))
    expect(parsed).toEqual({
      table: 29,
      row: [80001, 0, 32, 30, 32, 28, 33, 34, 1],
    })
  })

  it('throws loudly on a two-week 14B row instead of merging it into monthly data', () => {
    expect(() => parseLine(record('14B29', '20001', '20200'))).toThrow(/Two-week table row/)
    expect(() => parseLine(record('14%29', '80001', ''))).toThrow(/Two-week table row/)
  })

  it('skips rows with an unknown day-count prefix', () => {
    expect(parseLine(record('90B29', '20001', '20200'))).toBeNull()
  })

  it('skips non-table lines (headers, short lines)', () => {
    expect(parseLine('RUBRIK ALLMANNA TABELLER 2026')).toBeNull()
    expect(parseLine('')).toBeNull()
  })
})
