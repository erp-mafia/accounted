import { describe, expect, it } from 'vitest'
import { DATE_RANGE_SLUGS, REPORT_CATALOG, getLibrarySections, getReport, reportAppliesToForm } from '../catalog'

describe('report catalog: legal-form gates', () => {
  it('shows INK2 to the forms that file it and the NE-bilaga to the enskild firma only', () => {
    const slugsFor = (entityType: Parameters<typeof getLibrarySections>[0]) =>
      getLibrarySections(entityType, true, true).flatMap((s) => s.items.map((i) => i.slug))

    expect(slugsFor('aktiebolag')).toContain('ink2-declaration')
    expect(slugsFor('ekonomisk_forening')).toContain('ink2-declaration')
    expect(slugsFor('ekonomisk_forening')).not.toContain('ne-declaration')
    expect(slugsFor('enskild_firma')).toContain('ne-declaration')
    expect(slugsFor('enskild_firma')).not.toContain('ink2-declaration')
    expect(slugsFor('ideell_forening')).not.toContain('ink2-declaration')
    // BFL 6 kap. 1 §: an ekonomisk förening prepares an årsredovisning too.
    expect(slugsFor('ekonomisk_forening')).toContain('arsredovisning')
    expect(slugsFor('ideell_forening')).not.toContain('arsredovisning')
  })

  it('reportAppliesToForm handles a single form, a list, and an unknown company', () => {
    expect(reportAppliesToForm('aktiebolag', 'aktiebolag')).toBe(true)
    expect(reportAppliesToForm('aktiebolag', 'ekonomisk_forening')).toBe(false)
    expect(reportAppliesToForm(['aktiebolag', 'ekonomisk_forening'], 'ekonomisk_forening')).toBe(true)
    expect(reportAppliesToForm(['aktiebolag', 'ekonomisk_forening'], undefined)).toBe(false)
    expect(getReport('ink2-declaration')?.entityType).toEqual(['aktiebolag', 'ekonomisk_forening'])
  })
})

describe('report catalog: default windows', () => {
  it('gives a default window only to reports with a date range, and opens behandlingshistorik on the current month', () => {
    for (const report of REPORT_CATALOG.filter((r) => r.defaultRange)) {
      expect(DATE_RANGE_SLUGS.has(report.slug), report.slug).toBe(true)
    }
    expect(getReport('behandlingshistorik')?.defaultRange).toBe('this_month')
  })
})

describe('report catalog: the dimension cross report', () => {
  it('shows only with dimensions enabled, for every legal form, and takes no dimension filter', () => {
    const entry = getReport('dimension-cross')
    expect(entry?.needsDimensions).toBe(true)
    expect(entry?.entityType).toBeUndefined()
    expect(entry?.needsEmployees).toBeUndefined()
    // Its two dimensions are axes, not a filter on the report.
    expect(entry?.dimensions).toBeUndefined()
    expect(DATE_RANGE_SLUGS.has('dimension-cross')).toBe(true)
    const slugs = (dimensionsEnabled: boolean) =>
      getLibrarySections('aktiebolag', false, dimensionsEnabled).flatMap((s) => s.items.map((i) => i.slug))
    expect(slugs(true)).toContain('dimension-cross')
    expect(slugs(false)).not.toContain('dimension-cross')
  })
})

describe('report catalog: the library footnote', () => {
  // reports.catalog_footnote says most reports open for the period you choose
  // and can be downloaded as PDF or Excel (#1307: it used to claim every
  // report exports to PDF, true for a minority). Keep the claim true.
  it('gives most reports both a period and an export, and PDF to only some', () => {
    const total = REPORT_CATALOG.length
    const withBoth = REPORT_CATALOG.filter((r) => r.params !== 'none' && (r.exports ?? []).length > 0).length
    const withPdf = REPORT_CATALOG.filter((r) => r.exports?.includes('pdf')).length
    expect(withBoth * 2).toBeGreaterThan(total)
    expect(withPdf).toBeLessThan(total)
  })
})
