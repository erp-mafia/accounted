import { describe, it, expect } from 'vitest'
import { REPORT_CATALOG, reportMatchesQuery, getReport } from '@/lib/reports/catalog'

describe('reportMatchesQuery', () => {
  it('returns everything for an empty query', () => {
    expect(reportMatchesQuery('Huvudbok', '')).toBe(true)
    expect(reportMatchesQuery('Huvudbok', '   ')).toBe(true)
  })

  it('requires every token, so extra words narrow', () => {
    expect(reportMatchesQuery('Huvudbok verifikat per konto', 'verifikat konto')).toBe(true)
    expect(reportMatchesQuery('Huvudbok verifikat per konto', 'verifikat faktura')).toBe(false)
  })

  it('ignores case and diacritics in both directions', () => {
    expect(reportMatchesQuery('Stäm av bank', 'stam av')).toBe(true)
    expect(reportMatchesQuery('Stam av bank', 'stäm')).toBe(true)
    expect(reportMatchesQuery('Balansrapport', 'BALANS')).toBe(true)
  })

  it('matches on a substring so partial words still find the report', () => {
    expect(reportMatchesQuery('Momsdeklaration', 'moms')).toBe(true)
  })
})

describe('huvudbok is reachable by the words a bookkeeper uses', () => {
  const huvudbok = getReport('huvudbok')!
  const haystack = `Huvudbok ${huvudbok.searchTerms ?? ''}`

  // The phrase from the churn report that returned zero hits before.
  it.each([
    'verifikat per konto',
    'verifikationer',
    'kontoanalys',
    'kontokort',
    'stäm av konto',
    'account statement',
  ])('finds huvudbok for %j', (query) => {
    expect(reportMatchesQuery(haystack, query)).toBe(true)
  })
})

describe('catalog search terms', () => {
  it('never lets searchTerms shadow another report by slug', () => {
    // A report's synonyms must not be so broad that they swallow a query
    // aimed squarely at a different report's own name.
    const huvudbok = getReport('huvudbok')!
    const terms = huvudbok.searchTerms ?? ''
    for (const slug of ['balansrapport', 'resultatrapport', 'vat-declaration']) {
      expect(reportMatchesQuery(terms, slug)).toBe(false)
    }
  })

  it('keeps searchTerms lowercase-comparable and free of punctuation noise', () => {
    for (const report of REPORT_CATALOG) {
      if (!report.searchTerms) continue
      expect(report.searchTerms).toBe(report.searchTerms.trim())
      expect(report.searchTerms).not.toMatch(/[,;]/)
    }
  })
})
