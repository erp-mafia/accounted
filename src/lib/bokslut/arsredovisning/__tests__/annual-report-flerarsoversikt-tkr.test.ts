/**
 * The year's choice to state the flerårsöversikt in thousands of kronor,
 * followed the whole way: the narrative row
 * (arsredovisning_narratives.flerarsoversikt_tkr), the report, the iXBRL
 * input, the iXBRL document and the PDF, over three years of books in the
 * in-memory ledger. The PDF and the filed document must state the same
 * figures, and a year that does not ask for tkr must be untouched: its report
 * and its iXBRL input carry no new key, so its content hash does not move.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { createLedgerFakeDb, type LedgerRow } from '@/tests/ledger-fake-db'
import { BOOKS_COMPANY_ID, reportBooks } from '@/tests/fixtures/report-books'
import { pdfTextStrings } from '@/tests/pdf-text'
import { generateIxbrlDocument } from '@/lib/bokslut/ixbrl/document/generate'
import { roundThousands } from '@/lib/bokslut/ixbrl/thousand-kronor'
import { ArsredovisningPDF } from '../arsredovisning-pdf'
import { buildCanonicalAnnualReport } from '../model'
import { formatPdfKronor } from '../pdf-format'
import { annualReportContentHash } from '../version-service'

const OPTIONS = { generatedAt: '2026-02-01T10:00:00.000Z', todayIso: '2026-02-01' }
const RENDER_TIMEOUT = 30_000

/** The books with what the year's narrative row says about tkr: true, false, or no such column. */
function books(tkr: boolean | undefined): Record<string, LedgerRow[]> {
  const tables = reportBooks('aktiebolag')
  if (tkr !== undefined) tables.arsredovisning_narratives[0].flerarsoversikt_tkr = tkr
  return tables
}

async function build(tkr: boolean | undefined) {
  const db = createLedgerFakeDb({ companyId: BOOKS_COMPANY_ID, tables: books(tkr) })
  return buildCanonicalAnnualReport(db.supabase as never, BOOKS_COMPANY_ID, 'fp-2025', OPTIONS)
}

/** The tagged value of a concept in the flerårsöversikt table, per context: [text, scale]. */
function overviewFacts(xhtml: string, concept: string): Record<string, [string, string]> {
  const start = xhtml.indexOf('<th>Flerårsöversikt')
  const table = xhtml.slice(start, xhtml.indexOf('</table>', start))
  const out: Record<string, [string, string]> = {}
  for (const match of table.matchAll(/<ix:nonFraction ([^>]*)>([^<]*)<\/ix:nonFraction>/g)) {
    if (!match[1].includes(`name="se-gen-base:${concept}"`)) continue
    const context = /contextRef="([^"]+)"/.exec(match[1])?.[1] ?? ''
    out[context] = [`${/sign="-"/.test(match[1]) ? '-' : ''}${match[2]}`, /scale="([^"]+)"/.exec(match[1])?.[1] ?? '']
  }
  return out
}

/** sv-SE groups with a no-break space in the PDF and a plain space in iXBRL: compare on plain spaces. */
const plain = (text: string) => text.replace(/\s/g, ' ')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-02-01T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

describe('a year that states its flerårsöversikt in tkr', () => {
  it('carries the choice from the narrative row into the report and the iXBRL input, the rows still in kronor', async () => {
    const [tkr, kronor] = await Promise.all([build(true), build(false)])
    expect(tkr.report.forvaltningsberattelse.flerarsoversikt_tkr).toBe(true)
    expect(tkr.ixbrl?.forvaltningsberattelse.flerarsoversiktTkr).toBe(true)
    // The choice changes how the figures are stated, never the figures.
    expect(tkr.report.forvaltningsberattelse.flerarsoversikt).toEqual(kronor.report.forvaltningsberattelse.flerarsoversikt)
    expect(tkr.ixbrl?.forvaltningsberattelse.flerarsoversikt).toEqual(kronor.ixbrl?.forvaltningsberattelse.flerarsoversikt)
    expect(tkr.report.resultatrakning).toEqual(kronor.report.resultatrakning)
    expect(tkr.ixbrl?.rr).toEqual(kronor.ixbrl?.rr)
    // The cross-document check still passes: both documents read one set of figures.
    expect(tkr.validation.issues.map((issue) => issue.code)).not.toContain('AR-IXBRL-STATEMENT-MISMATCH')
  })

  it('states the same tkr figures in the iXBRL document and in the PDF', async () => {
    const model = await build(true)
    if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
    const rows = model.report.forvaltningsberattelse.flerarsoversikt
    // The books hold three years with figures worth rounding.
    expect(rows.map((row) => row.year)).toEqual(['2023', '2024', '2025'])
    expect(rows.some((row) => row.net_revenue % 1000 !== 0 || row.result_after_financial % 1000 !== 0)).toBe(true)

    const { xhtml } = generateIxbrlDocument(model.ixbrl)
    expect(xhtml).toContain('<th>Flerårsöversikt (tkr)</th>')
    const net = overviewFacts(xhtml, 'Nettoomsattning')
    const result = overviewFacts(xhtml, 'ResultatEfterFinansiellaPoster')

    const pdf = pdfTextStrings(await renderToBuffer(ArsredovisningPDF({ data: model.report }))).join('\n')
    expect(pdf).toContain('Flerårsöversikt (tkr)')

    // Newest first in the document (period0 is the year), oldest first in the PDF.
    ;[...rows].reverse().forEach((row, index) => {
      const netTkr = formatPdfKronor(roundThousands(row.net_revenue))
      const resultTkr = formatPdfKronor(roundThousands(row.result_after_financial))
      expect(net[`period${index}`]).toEqual([plain(netTkr), row.net_revenue === 0 ? '0' : '3'])
      expect(result[`period${index}`]).toEqual([plain(resultTkr), row.result_after_financial === 0 ? '0' : '3'])
      const soliditet = row.soliditet_pct === null ? '-' : row.soliditet_pct.toFixed(1)
      expect(pdf).toContain(`${row.year}${plain(netTkr)}${plain(resultTkr)}${soliditet}`)
    })
  }, RENDER_TIMEOUT)
})

describe('a year that does not', () => {
  it('has no key for it in the report or the iXBRL input, whether the choice is off or the column is not there yet', async () => {
    for (const model of [await build(false), await build(undefined)]) {
      expect(model.report.forvaltningsberattelse).not.toHaveProperty('flerarsoversikt_tkr')
      expect(model.ixbrl?.forvaltningsberattelse).not.toHaveProperty('flerarsoversiktTkr')
      if (!model.ixbrl) throw new Error('the model carries no iXBRL input')
      expect(generateIxbrlDocument(model.ixbrl).xhtml).toContain('<th>Flerårsöversikt (kr)</th>')
    }
  })

  it('keeps its content hash, and a year that turns tkr on gets another', async () => {
    const [before, off, on] = await Promise.all([build(undefined), build(false), build(true)])
    expect(annualReportContentHash(off)).toBe(annualReportContentHash(before))
    expect(annualReportContentHash(on)).not.toBe(annualReportContentHash(before))
  })
})
