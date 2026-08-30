import { describe, it, expect } from 'vitest'
import { renderToBuffer } from '@react-pdf/renderer'
import { FinancialStatementPDF } from '../financial-statement-pdf-template'
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
      groups: [
        {
          heading: 'Tillgångar',
          sections: [
            {
              title: 'Kassa och bank',
              rows: [
                { account_number: '1930', account_name: 'Företagskonto', amount: 125_432.5 },
              ],
              subtotal: 125_432.5,
            },
          ],
          totalLabel: 'Summa tillgångar',
          total: 125_432.5,
        },
        {
          heading: 'Eget kapital och skulder',
          sections: [
            {
              title: 'Eget kapital',
              rows: [
                { account_number: '2010', account_name: 'Eget kapital', amount: 100_000 },
                { account_number: '2091', account_name: 'Balanserat resultat', amount: 25_432.5 },
              ],
              subtotal: 125_432.5,
            },
          ],
          totalLabel: 'Summa eget kapital och skulder',
          total: 125_432.5,
        },
      ],
      period: { start: '2026-01-01', end: '2026-12-31' },
      company: fakeCompany(),
      generatedAt: '2026-04-21T10:00:00Z',
    })

    const buffer = await renderToBuffer(doc)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.length).toBeGreaterThan(1000)
    // PDF files always start with "%PDF-"
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
  }, RENDER_TIMEOUT)

  it('renders an income-statement-shaped document with a summary block', async () => {
    const doc = FinancialStatementPDF({
      title: 'Resultaträkning',
      groups: [
        {
          heading: 'Rörelseintäkter',
          sections: [
            {
              title: 'Huvudintäkter',
              rows: [
                { account_number: '3001', account_name: 'Försäljning 25%', amount: 500_000 },
              ],
              subtotal: 500_000,
            },
          ],
          totalLabel: 'Summa rörelseintäkter',
          total: 500_000,
        },
        {
          heading: 'Rörelsekostnader',
          sections: [
            {
              title: 'Lokalkostnader',
              rows: [
                { account_number: '5010', account_name: 'Lokalhyra', amount: 120_000 },
              ],
              subtotal: 120_000,
            },
          ],
          totalLabel: 'Summa rörelsekostnader',
          total: 120_000,
          negate: true,
        },
      ],
      summary: [
        { label: 'Rörelseresultat', amount: 380_000 },
        { label: 'Årets resultat', amount: 380_000, emphasis: true },
      ],
      period: { start: '2026-01-01', end: '2026-12-31' },
      company: fakeCompany(),
      generatedAt: '2026-04-21T10:00:00Z',
    })

    const buffer = await renderToBuffer(doc)
    expect(buffer).toBeInstanceOf(Buffer)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
  }, RENDER_TIMEOUT)

  it('handles empty section groups gracefully', async () => {
    const doc = FinancialStatementPDF({
      title: 'Balansräkning',
      groups: [
        {
          heading: 'Tillgångar',
          sections: [],
          totalLabel: 'Summa tillgångar',
          total: 0,
        },
        {
          heading: 'Eget kapital och skulder',
          sections: [],
          totalLabel: 'Summa eget kapital och skulder',
          total: 0,
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
      groups: [
        {
          heading: 'Eget kapital och skulder',
          sections: [
            {
              title: 'Eget kapital',
              rows: [
                { account_number: '2081', account_name: 'Aktiekapital', amount: 25_000 },
                { account_number: '2099', account_name: 'Årets resultat', amount: -4684.24 },
              ],
              subtotal: 20_315.76,
            },
          ],
          totalLabel: 'Summa eget kapital och skulder',
          total: 20_315.76,
        },
      ],
      summary: [{ label: 'Årets resultat', amount: -4684.24, emphasis: true }],
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
})
