import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Regression pin for crm#1680: the series filter offered a fixed A-G. The
 * repo does not render components in tests, so pin the source shape; the
 * letters themselves are tested in lib/bookkeeping/__tests__/series-filter-letters.test.ts.
 */
describe('JournalEntryList series filter', () => {
  const SRC = fs.readFileSync(path.resolve(__dirname, '../JournalEntryList.tsx'), 'utf8')

  it('builds its options from the series in use, not a fixed A-G', () => {
    expect(SRC).not.toContain("'ABCDEFG'")
    expect(SRC).toContain('useSeriesFilterLetters(company?.id, seriesFilter)')
    expect(SRC).toContain('{seriesLetters.map((letter) => (')
  })
})
