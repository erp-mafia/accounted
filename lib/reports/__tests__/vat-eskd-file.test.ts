import { describe, it, expect } from 'vitest'
import { buildESkdFile } from '@/lib/reports/vat-eskd-file'
import { buildManualFilingRows } from '@/lib/reports/vat-manual-filing'
import type { VatDeclarationRutor } from '@/types'

/** All rutor zeroed; override the ones a case cares about. */
function makeRutor(overrides: Partial<VatDeclarationRutor> = {}): VatDeclarationRutor {
  return {
    ruta05: 0, ruta06: 0, ruta07: 0, ruta08: 0,
    ruta10: 0, ruta11: 0, ruta12: 0,
    ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0,
    ruta30: 0, ruta31: 0, ruta32: 0,
    ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0, ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
    ruta48: 0,
    ruta49: 0,
    ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    ...overrides,
  }
}

const ORG = '556000-0175'
const PERIOD_END = '2025-03-31' // Q1 2025 or March 2025 → <Period>202503</Period>

describe('buildESkdFile', () => {
  it('emits the eSKD header, OrgNr and Period per the SKV file spec', () => {
    const xml = buildESkdFile(makeRutor({ ruta49: 0 }), { orgNumber: ORG, periodEnd: PERIOD_END })
    const lines = xml.split('\r\n')
    expect(lines[0]).toBe('<?xml version="1.0" encoding="ISO-8859-1"?>')
    expect(lines[1]).toBe('<eSKDUpload Version="6.0">')
    expect(lines[2]).toBe('<OrgNr>556000-0175</OrgNr>')
    expect(lines[3]).toBe('<Moms>')
    expect(lines[4]).toBe('<Period>202503</Period>')
    expect(xml.endsWith('</Moms>\r\n</eSKDUpload>\r\n')).toBe(true)
  })

  it('maps rutor to their eSKD tags (Exempel 1: moms att betala)', () => {
    const xml = buildESkdFile(
      makeRutor({ ruta05: 100000, ruta10: 25000, ruta48: 1000 }),
      { orgNumber: ORG, periodEnd: '2024-01-31' },
    )
    expect(xml).toContain('<ForsMomsEjAnnan>100000</ForsMomsEjAnnan>')
    expect(xml).toContain('<MomsUtgHog>25000</MomsUtgHog>')
    expect(xml).toContain('<MomsIngAvdr>1000</MomsIngAvdr>')
    expect(xml).toContain('<MomsBetala>24000</MomsBetala>')
    expect(xml).toContain('<Period>202401</Period>')
  })

  it('omits zero rutor but always emits MomsBetala (Exempel 3: inget att deklarera)', () => {
    const xml = buildESkdFile(makeRutor(), { orgNumber: ORG, periodEnd: PERIOD_END })
    expect(xml).not.toContain('<ForsMomsEjAnnan>')
    expect(xml).not.toContain('<MomsIngAvdr>')
    expect(xml).toContain('<MomsBetala>0</MomsBetala>')
  })

  it('writes a refund with a leading minus and no plus sign (Exempel 2)', () => {
    const xml = buildESkdFile(
      makeRutor({ ruta05: 100000, ruta10: 25000, ruta48: 55000 }),
      { orgNumber: ORG, periodEnd: '2024-01-31' },
    )
    expect(xml).toContain('<MomsBetala>-30000</MomsBetala>')
    expect(xml).not.toContain('+')
  })

  it('truncates öre to whole kronor (öretal faller bort), never rounds up', () => {
    const xml = buildESkdFile(
      makeRutor({ ruta05: 100000.99, ruta10: 25000.75, ruta48: 999.99 }),
      { orgNumber: ORG, periodEnd: PERIOD_END },
    )
    expect(xml).toContain('<ForsMomsEjAnnan>100000</ForsMomsEjAnnan>')
    expect(xml).toContain('<MomsUtgHog>25000</MomsUtgHog>')
    expect(xml).toContain('<MomsIngAvdr>999</MomsIngAvdr>')
    // Net = 25000 (truncated) - 999 (truncated) = 24001.
    expect(xml).toContain('<MomsBetala>24001</MomsBetala>')
  })

  it('emits reverse-charge and import rutor with the correct tags', () => {
    const xml = buildESkdFile(
      makeRutor({ ruta21: 5000, ruta30: 1250, ruta50: 10000, ruta60: 2000, ruta48: 3250 }),
      { orgNumber: ORG, periodEnd: PERIOD_END },
    )
    expect(xml).toContain('<InkopTjanstAnnatEg>5000</InkopTjanstAnnatEg>')
    expect(xml).toContain('<MomsInkopUtgHog>1250</MomsInkopUtgHog>')
    expect(xml).toContain('<MomsUlagImport>10000</MomsUlagImport>')
    expect(xml).toContain('<MomsImportUtgHog>2000</MomsImportUtgHog>')
    // Net = (1250 + 2000) - 3250 = 0.
    expect(xml).toContain('<MomsBetala>0</MomsBetala>')
  })

  it('derives <Period> from the period end month for all period lengths', () => {
    // Yearly räkenskapsår ending in a non-December month.
    const xml = buildESkdFile(makeRutor(), { orgNumber: ORG, periodEnd: '2025-06-30' })
    expect(xml).toContain('<Period>202506</Period>')
  })

  it('accepts an unformatted org number and normalises it', () => {
    const xml = buildESkdFile(makeRutor(), { orgNumber: '5560000175', periodEnd: PERIOD_END })
    expect(xml).toContain('<OrgNr>556000-0175</OrgNr>')
  })

  it('strips the century prefix from a 12-digit org number', () => {
    const xml = buildESkdFile(makeRutor(), { orgNumber: '165560000175', periodEnd: PERIOD_END })
    expect(xml).toContain('<OrgNr>556000-0175</OrgNr>')
  })

  it('emits the import block (rutor 50/60/61/62) BEFORE MomsIngAvdr per the SKV radnummer order', () => {
    const xml = buildESkdFile(
      makeRutor({ ruta48: 3250, ruta50: 10000, ruta60: 2000, ruta61: 120, ruta62: 60 }),
      { orgNumber: ORG, periodEnd: PERIOD_END },
    )
    const order = ['MomsUlagImport', 'MomsImportUtgHog', 'MomsImportUtgMedel', 'MomsImportUtgLag', 'MomsIngAvdr']
      .map((tag) => xml.indexOf(`<${tag}>`))
    expect(order.every((idx) => idx >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('throws on an org number without exactly 10 digits', () => {
    expect(() => buildESkdFile(makeRutor(), { orgNumber: '12345', periodEnd: PERIOD_END })).toThrow()
  })

  it('throws on a malformed period end date', () => {
    expect(() => buildESkdFile(makeRutor(), { orgNumber: ORG, periodEnd: '2025-3' })).toThrow()
  })

  it('ties out to the PDF net for the same rutor', () => {
    const rutor = makeRutor({ ruta05: 100000, ruta10: 25000, ruta11: 1200, ruta48: 3333 })
    const xml = buildESkdFile(rutor, { orgNumber: ORG, periodEnd: PERIOD_END })
    const pdfRows = buildManualFilingRows(rutor)
    const pdfNet = pdfRows.find((r) => r.ruta === '49')!
    // PDF carries the absolute value + label; XML carries the signed net.
    const signedPdfNet = pdfNet.label === 'Moms att återfå' ? -pdfNet.amount : pdfNet.amount
    expect(xml).toContain(`<MomsBetala>${signedPdfNet}</MomsBetala>`)
  })
})
