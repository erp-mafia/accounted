import { describe, it, expect } from 'vitest'
import { isValidElement } from 'react'
import { renderToBuffer } from '@react-pdf/renderer'
import {
  ReskontraPDF,
  type ReskontraAgingRow,
  type ReskontraInvoiceRow,
} from '../reskontra-pdf-template'
import type { CompanySettings } from '@/types'
import { pdfTextStrings } from '@/tests/pdf-text'

/**
 * Flatten every string/number leaf of a react-pdf element tree in document
 * order. Joining with '' reproduces the text of any single <Text>, which is
 * what the unit-labelling assertions below check.
 */
function renderedText(node: unknown): string {
  const out: string[] = []
  const walk = (n: unknown): void => {
    if (n === null || n === undefined || typeof n === 'boolean') return
    if (typeof n === 'string' || typeof n === 'number') {
      out.push(String(n))
      return
    }
    if (Array.isArray(n)) {
      n.forEach(walk)
      return
    }
    if (isValidElement(n)) {
      walk((n.props as { children?: unknown }).children)
    }
  }
  walk(node)
  // Intl's sv-SE group separator is a non-breaking space; normalise every
  // space-like character so the assertions below can use ordinary spaces.
  return out.join('').replace(/\s/g, ' ')
}

function fakeCompany(): CompanySettings {
  return {
    company_name: 'Testbolaget AB',
    org_number: '5566778899',
  } as unknown as CompanySettings
}

function agingRow(over: Partial<ReskontraAgingRow> = {}): ReskontraAgingRow {
  return {
    name: 'Acme AB',
    current: 0,
    days_1_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_90_plus: 0,
    total_outstanding: 0,
    ...over,
  }
}

function invoiceRow(over: Partial<ReskontraInvoiceRow> = {}): ReskontraInvoiceRow {
  return {
    counterparty: 'Acme AB',
    invoice_number: 'F001',
    invoice_date: '2026-05-01',
    due_date: '2026-06-01',
    outstanding: 1000,
    outstanding_sek: 1000,
    currency: 'SEK',
    days_overdue: 14,
    ...over,
  }
}

function build(over: {
  aging?: ReskontraAgingRow[]
  totals?: ReskontraAgingRow
  invoices?: ReskontraInvoiceRow[]
  unpaidCount?: number
  unconvertedFxCount?: number
}) {
  return ReskontraPDF({
    title: 'Kundreskontra',
    counterpartyLabel: 'Kund',
    asOfDate: '2026-06-15',
    aging: over.aging ?? [],
    totals: over.totals ?? agingRow({ name: 'Summa' }),
    unpaidCount: over.unpaidCount ?? 0,
    unconvertedFxCount: over.unconvertedFxCount ?? 0,
    invoices: over.invoices,
    company: fakeCompany(),
    generatedAt: '2026-06-15T10:00:00Z',
  })
}

describe('ReskontraPDF unit disclosure', () => {
  it('labels the aging table as SEK even for a SEK-only company', () => {
    const text = renderedText(
      build({
        aging: [agingRow({ days_1_30: 1000, total_outstanding: 1000 })],
        totals: agingRow({ name: 'Summa', days_1_30: 1000, total_outstanding: 1000 }),
        invoices: [invoiceRow()],
        unpaidCount: 1,
      })
    )

    expect(text).toContain('Åldersfördelning per kund (SEK)')
    expect(text).toContain('Alla belopp i SEK')
  })

  it('leaves a SEK-only invoice table without the bridge column and states its unit', () => {
    const text = renderedText(
      build({
        aging: [agingRow({ days_1_30: 1000, total_outstanding: 1000 })],
        totals: agingRow({ name: 'Summa', days_1_30: 1000, total_outstanding: 1000 }),
        invoices: [invoiceRow(), invoiceRow({ invoice_number: 'F002' })],
        unpaidCount: 2,
      })
    )

    // No redundant second SEK column when both tables are already SEK.
    expect(text).not.toContain('Utest. SEK')
    expect(text).toContain('Fakturor (SEK)')
    expect(text).toContain('samma enhet som åldersfördelningen ovan')
  })

  it('shows the SEK bridge column and unambiguous units for a mixed-currency company', () => {
    const text = renderedText(
      build({
        aging: [agingRow({ days_1_30: 12475, total_outstanding: 12475 })],
        totals: agingRow({ name: 'Summa', days_1_30: 12475, total_outstanding: 12475 }),
        invoices: [
          invoiceRow({ invoice_number: 'F001', outstanding: 1000, outstanding_sek: 1000 }),
          invoiceRow({
            invoice_number: 'F002',
            outstanding: 1000,
            outstanding_sek: 11475,
            currency: 'EUR',
          }),
        ],
        unpaidCount: 2,
      })
    )

    // The aging table is SEK, the line table is invoice currency, and both say so.
    expect(text).toContain('Åldersfördelning per kund (SEK)')
    expect(text).toContain('Fakturor (fakturans valuta)')
    expect(text).toContain('Utest. SEK')
    // The bridge amount itself: 1 000 EUR at 11.475 = 11 475,00 SEK.
    expect(text).toContain('11 475,00')
    expect(text).toContain('ingår i åldersfördelningen ovan')
    expect(text).toContain('blandar valutor')
    // The SEK column totals to the same figure as the aging summary above it.
    expect(text).toContain('12 475,00')
  })

  it('counts an unconvertible FX invoice visibly instead of dropping it', () => {
    const text = renderedText(
      build({
        aging: [agingRow({ days_1_30: 1000, total_outstanding: 1000 })],
        totals: agingRow({ name: 'Summa', days_1_30: 1000, total_outstanding: 1000 }),
        invoices: [
          invoiceRow({ invoice_number: 'F001' }),
          invoiceRow({
            invoice_number: 'F002',
            outstanding: 500,
            outstanding_sek: null,
            currency: 'USD',
          }),
        ],
        unpaidCount: 2,
        unconvertedFxCount: 1,
      })
    )

    // Listed as a row...
    expect(text).toContain('F002')
    expect(text).toContain('USD')
    // ...with the missing conversion called out in the SEK cell...
    expect(text).toContain('saknas')
    // ...and counted in the note, which explains what it is missing from.
    expect(text).toContain('1 faktura i utländsk valuta saknar växelkurs')
    expect(text).toContain('ingår därför inte i åldersfördelningen i SEK ovan')
    expect(text).toContain('markerade med "saknas" i kolumnen Utest. SEK')
    // It stays out of the SEK column total: 1 000, not 1 500.
    expect(text).toContain('Summa1 000,00')
    expect(text).not.toContain('1 500,00')
  })

  it('pluralises the unconverted note and omits the column hint without an invoice table', () => {
    // Supplier ledger shape: aging only, no per-invoice rows.
    const text = renderedText(
      build({
        aging: [agingRow({ name: 'Leverantör AB', current: 500, total_outstanding: 500 })],
        totals: agingRow({ name: 'Summa', current: 500, total_outstanding: 500 }),
        unpaidCount: 1,
        unconvertedFxCount: 3,
      })
    )

    expect(text).toContain('3 fakturor i utländsk valuta saknar växelkurs')
    expect(text).not.toContain('Utest. SEK')
  })

  it('still lays out to a real PDF with the extra column', async () => {
    const doc = build({
      aging: [agingRow({ days_1_30: 12475, total_outstanding: 12475 })],
      totals: agingRow({ name: 'Summa', days_1_30: 12475, total_outstanding: 12475 }),
      invoices: [
        invoiceRow({ counterparty: 'Ett ovanligt långt kundnamn AB', outstanding_sek: 1000 }),
        invoiceRow({ invoice_number: 'F002', outstanding_sek: 11475, currency: 'EUR' }),
        invoiceRow({ invoice_number: 'F003', outstanding_sek: null, currency: 'USD' }),
      ],
      unpaidCount: 3,
      unconvertedFxCount: 1,
    })

    const buffer = await renderToBuffer(doc)
    expect(buffer.slice(0, 5).toString()).toBe('%PDF-')
    expect(buffer.length).toBeGreaterThan(1000)
    // Real react-pdf layout plus font loading: slower than the 5s default.
  }, 30000)
})

describe('ReskontraPDF sign rendering (issue #1982)', () => {
  it('prints a credit-note balance with an ASCII minus the bundled font can draw', async () => {
    const buffer = await renderToBuffer(
      build({
        aging: [agingRow({ current: -500, total_outstanding: -500 })],
        totals: agingRow({ name: 'Summa', current: -500, total_outstanding: -500 }),
        invoices: [invoiceRow({ outstanding: -500, outstanding_sek: -500 })],
        unpaidCount: 1,
      })
    )
    const text = pdfTextStrings(buffer).join('\n')
    expect(text).toContain('-500,00')
    expect(text).not.toContain(String.fromCharCode(0x12))
    expect(text).not.toContain('\u2212')
  }, 30_000)
})
