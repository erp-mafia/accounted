import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { FinancialStatementPDF } from '../financial-statement-pdf-template'
import {
  BALANCE_SHEET_PDF_COLUMNS,
  INCOME_STATEMENT_PDF_COLUMNS,
} from '../financial-statement-pdf'
import type { CompanySettings } from '@/types'
import { pdfTextStrings } from '@/tests/pdf-text'

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Gnubok',
    org_number: '5566778899',
    vat_number: 'SE556677889901',
    address_line1: 'Kungsgatan 1',
    postal_code: '11143',
    city: 'Stockholm',
    country: 'SE',
    entity_type: 'aktiebolag',
  } as unknown as CompanySettings
}

// Real @react-pdf/renderer layout is CPU-heavy; under a fully parallel
// test run these can exceed the 5s default on a saturated machine.
const RENDER_TIMEOUT = 30_000

describe('FinancialStatementPDF', () => {
  it('renders a balance-sheet-shaped document to a PDF buffer', async () => {
    const doc = FinancialStatementPDF({
      title: 'Balansräkning',
      columns: BALANCE_SHEET_PDF_COLUMNS,
      groups: [
        {
          heading: 'Tillgångar',
          sections: [
            {
              title: 'Kassa och bank',
              rows: [
                {
                  account_number: '1930',
                  account_name: 'Företagskonto',
                  amounts: [100_000, 110_000, 15_432.5, 125_432.5],
                },
              ],
              subtotals: [100_000, 110_000, 15_432.5, 125_432.5],
            },
          ],
          totalLabel: 'Summa tillgångar',
          totals: [100_000, 110_000, 15_432.5, 125_432.5],
        },
        {
          heading: 'Eget kapital och skulder',
          sections: [
            {
              title: 'Eget kapital',
              rows: [
                {
                  account_number: '2010',
                  account_name: 'Eget kapital',
                  amounts: [100_000, 100_000, 0, 100_000],
                },
                {
                  account_number: '2091',
                  account_name: 'Balanserat resultat',
                  amounts: [0, 10_000, 15_432.5, 25_432.5],
                },
              ],
              subtotals: [100_000, 110_000, 15_432.5, 125_432.5],
            },
          ],
          totalLabel: 'Summa eget kapital och skulder',
          totals: [100_000, 110_000, 15_432.5, 125_432.5],
        },
      ],
      period: { start: '2026-01-01', end: '2026-12-31' },
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
      company: fakeCompany(),
      generatedAt: '2026-04-21T10:00:00Z',
    })

    const buffer = await renderToBuffer(doc)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.length).toBeGreaterThan(1000)
    // PDF files always start with "%PDF-"
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
  }, RENDER_TIMEOUT)

  it('prints the column headers and the räkenskapsår line', async () => {
    const doc = FinancialStatementPDF({
      title: 'Balansräkning',
      columns: BALANCE_SHEET_PDF_COLUMNS,
      groups: [
        {
          heading: 'Tillgångar',
          sections: [
            {
              title: 'Kassa och bank',
              rows: [
                {
                  account_number: '1930',
                  account_name: 'Företagskonto',
                  amounts: [1000, 1500, 500, 2000],
                },
              ],
              subtotals: [1000, 1500, 500, 2000],
            },
          ],
          totalLabel: 'Summa tillgångar',
          totals: [1000, 1500, 500, 2000],
        },
      ],
      period: { start: '2026-04-01', end: '2026-06-30' },
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
      company: fakeCompany(),
      generatedAt: '2026-07-01T10:00:00Z',
    })

    const text = pdfTextStrings(await renderToBuffer(doc)).join('\n')
    for (const column of BALANCE_SHEET_PDF_COLUMNS) {
      expect(text).toContain(column.label.toUpperCase())
    }
    // The window is a quarter; the räkenskapsår line discloses which year the
    // Ing. balans column opens from.
    expect(text).toContain('Period:')
    expect(text).toContain('Räkenskapsår:')
    expect(text).toContain('2026-01-01')
    expect(text).toContain('2026-12-31')
  }, RENDER_TIMEOUT)

  it('renders an income-statement-shaped document with a summary block', async () => {
    const doc = FinancialStatementPDF({
      title: 'Resultaträkning',
      columns: INCOME_STATEMENT_PDF_COLUMNS,
      groups: [
        {
          heading: 'Rörelseintäkter',
          sections: [
            {
              title: 'Huvudintäkter',
              rows: [
                {
                  account_number: '3001',
                  account_name: 'Försäljning 25%',
                  amounts: [200_000, 500_000, 700_000],
                },
              ],
              subtotals: [200_000, 500_000, 700_000],
            },
          ],
          totalLabel: 'Summa rörelseintäkter',
          totals: [200_000, 500_000, 700_000],
        },
        {
          heading: 'Rörelsekostnader',
          sections: [
            {
              title: 'Lokalkostnader',
              rows: [
                {
                  account_number: '5010',
                  account_name: 'Lokalhyra',
                  amounts: [40_000, 120_000, 160_000],
                },
              ],
              subtotals: [40_000, 120_000, 160_000],
            },
          ],
          totalLabel: 'Summa rörelsekostnader',
          totals: [40_000, 120_000, 160_000],
          negate: true,
        },
      ],
      summary: [
        { label: 'Rörelseresultat', amounts: [160_000, 380_000, 540_000] },
        { label: 'Årets resultat', amounts: [160_000, 380_000, 540_000], emphasis: true },
      ],
      period: { start: '2026-01-01', end: '2026-12-31' },
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
      company: fakeCompany(),
      generatedAt: '2026-04-21T10:00:00Z',
    })

    const buffer = await renderToBuffer(doc)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
    const text = pdfTextStrings(buffer).join('\n')
    for (const column of INCOME_STATEMENT_PDF_COLUMNS) {
      expect(text).toContain(column.label.toUpperCase())
    }
    // negate flips every column of the expense group, not just the last one.
    expect(text).toContain('-120 000,00')
    expect(text).toContain('-40 000,00')
  }, RENDER_TIMEOUT)

  it('handles empty section groups gracefully', async () => {
    const doc = FinancialStatementPDF({
      title: 'Balansräkning',
      columns: BALANCE_SHEET_PDF_COLUMNS,
      groups: [
        {
          heading: 'Tillgångar',
          sections: [],
          totalLabel: 'Summa tillgångar',
          totals: [0, 0, 0, 0],
        },
        {
          heading: 'Eget kapital och skulder',
          sections: [],
          totalLabel: 'Summa eget kapital och skulder',
          totals: [0, 0, 0, 0],
        },
      ],
      period: { start: '', end: '' },
      company: fakeCompany(),
      generatedAt: '2026-04-21T10:00:00Z',
    })

    const buffer = await renderToBuffer(doc)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
  }, RENDER_TIMEOUT)

  it('prints a loss with its sign in the rendered bytes (issue #1982)', async () => {
    // sv-SE formats negatives with U+2212, which the bundled Helvetica cannot
    // draw: Årets resultat -4 684,24 used to print as 4 684,24 in both the
    // resultaträkning summary and the balansräkning 2099 row.
    const doc = FinancialStatementPDF({
      title: 'Balansräkning',
      columns: BALANCE_SHEET_PDF_COLUMNS,
      groups: [
        {
          heading: 'Eget kapital och skulder',
          sections: [
            {
              title: 'Eget kapital',
              rows: [
                {
                  account_number: '2081',
                  account_name: 'Aktiekapital',
                  amounts: [25_000, 25_000, 0, 25_000],
                },
                {
                  account_number: '2099',
                  account_name: 'Årets resultat',
                  amounts: [0, 0, -4684.24, -4684.24],
                },
              ],
              subtotals: [25_000, 25_000, -4684.24, 20_315.76],
            },
          ],
          totalLabel: 'Summa eget kapital och skulder',
          totals: [25_000, 25_000, -4684.24, 20_315.76],
        },
      ],
      summary: [
        { label: 'Årets resultat', amounts: [0, 0, -4684.24, -4684.24], emphasis: true },
      ],
      period: { start: '2025-10-14', end: '2026-01-31' },
      company: fakeCompany(),
      generatedAt: '2026-08-27T10:00:00Z',
    })

    const text = pdfTextStrings(await renderToBuffer(doc)).join('\n')
    expect(text).toContain('-4 684,24')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain('\u2212')
    expect(text).toContain('20 315,76')
  }, RENDER_TIMEOUT)

  it('prints the widest sv-SE amount in every column without dropping a digit', async () => {
    // "-123 456 789,00" is 15 characters, the widest figure the report can
    // hold. Courier at 9pt is 5.4pt per character, so it fills the 82pt cell
    // exactly. sv-SE groups with U+00A0, so an amount that does not fit
    // overflows rather than wrapping, and the check is that all four columns
    // still come back whole.
    const widest = -123_456_789
    const doc = FinancialStatementPDF({
      title: 'Balansräkning',
      columns: BALANCE_SHEET_PDF_COLUMNS,
      groups: [
        {
          heading: 'Tillgångar',
          sections: [
            {
              title: 'Kassa och bank',
              rows: [
                {
                  account_number: '1930',
                  account_name: 'Företagskonto',
                  amounts: [widest, widest, widest, widest],
                },
                {
                  account_number: '1940',
                  account_name: 'Annan bank',
                  amounts: [widest, widest, widest, widest],
                },
              ],
              subtotals: [widest, widest, widest, widest],
            },
          ],
          totalLabel: 'Summa tillgångar',
          totals: [widest, widest, widest, widest],
        },
      ],
      summary: [
        { label: 'Beräknat resultat', amounts: [widest, widest, widest, widest] },
        { label: 'Årets resultat', amounts: [widest, widest, widest, widest], emphasis: true },
      ],
      period: { start: '2026-01-01', end: '2026-12-31' },
      fiscalYear: { start: '2026-01-01', end: '2026-12-31' },
      company: fakeCompany(),
      generatedAt: '2026-04-21T10:00:00Z',
    })

    const text = pdfTextStrings(await renderToBuffer(doc)).join('\n')
    expect(text).toContain('-123 456 789,00')
    // Two rows, one section subtotal, one group total and two summary rows,
    // four columns each: 24 cells, none of them clipped or dropped.
    const cells = text.split('-123 456 789,00').length - 1
    expect(cells).toBe(24)
  }, RENDER_TIMEOUT)
})
