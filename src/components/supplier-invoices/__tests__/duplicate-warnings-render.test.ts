/**
 * The editor's duplicate warnings as a person reads them, rendered under
 * both catalogues: a missing key or a broken ICU argument fails here, and
 * the sentences name what they must (number, date, amount, verifikat).
 */
import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderInLocale, visibleText } from '@/tests/i18n-render'
import { DuplicateNumberLine, ReusedReferenceLine } from '../DuplicateWarnings'
import type {
  RegisteredSupplierInvoice,
  SupplierInvoiceReferenceReuse,
} from '@/lib/supplier-invoices/duplicate-lookup'

const invoice = (overrides: Partial<RegisteredSupplierInvoice> = {}): RegisteredSupplierInvoice => ({
  id: 'si-1',
  supplier_invoice_number: 'EX-0990',
  arrival_number: 31,
  invoice_date: '2026-10-03',
  total: 2185,
  currency: 'SEK',
  ore_rounding: null,
  status: 'approved',
  voucher: { journal_entry_id: 'je-1', label: 'A64' },
  ...overrides,
})

const reuse = (overrides: Partial<SupplierInvoiceReferenceReuse> = {}): SupplierInvoiceReferenceReuse => ({
  invoice: invoice(),
  count: 1,
  needs_acknowledgement: true,
  ...overrides,
})

/** The line as one sentence: its text nodes joined, spaces normalised. */
const read = (html: string) => visibleText(html).join(' ')

describe('DuplicateNumberLine', () => {
  const line = (twin: RegisteredSupplierInvoice, locale: 'sv' | 'en') =>
    read(renderInLocale(createElement(DuplicateNumberLine, { number: 'EX-1042', invoice: twin }), locale))

  it('names the verifikat the invoice with that number is booked on', () => {
    const twin = invoice({ supplier_invoice_number: 'EX-1042', voucher: { journal_entry_id: 'je-7', label: 'A71' } })
    expect(line(twin, 'sv')).toBe('Fakturanummer EX-1042 används redan på verifikat A71. Visa fakturan')
    expect(line(twin, 'en')).toBe('Invoice number EX-1042 is already used on verifikat A71. View the invoice')
  })

  it('keeps the sentence without a verifikat while that invoice is not booked', () => {
    const twin = invoice({ supplier_invoice_number: 'EX-1042', voucher: null })
    expect(line(twin, 'sv')).toBe('EX-1042 är redan registrerad för den här leverantören. Visa fakturan')
    expect(line(twin, 'en')).toBe('EX-1042 is already registered for this supplier. View the invoice')
  })

  it('links to the invoice in a new tab, so the form is not lost', () => {
    const html = renderInLocale(createElement(DuplicateNumberLine, { number: 'EX-1042', invoice: invoice() }), 'sv')
    expect(html).toContain('href="/supplier-invoices/si-1"')
    expect(html).toContain('target="_blank"')
  })
})

describe('ReusedReferenceLine', () => {
  const line = (found: SupplierInvoiceReferenceReuse, locale: 'sv' | 'en') =>
    read(renderInLocale(createElement(ReusedReferenceLine, { reuse: found }), locale))

  it('names the other invoice: number, date, amount and verifikat', () => {
    expect(line(reuse(), 'sv')).toBe(
      'Referensen används redan på faktura EX-0990 (2026-10-03, 2 185 kr), verifikat A64. Visa fakturan',
    )
    expect(line(reuse(), 'en')).toBe(
      'The reference is already on invoice EX-0990 (2026-10-03, 2 185 kr), verifikat A64. View the invoice',
    )
  })

  it('names an invoice without a number by its ankomstnummer, and no verifikat while it is not booked', () => {
    const found = reuse({ invoice: invoice({ supplier_invoice_number: null, arrival_number: 1234, total: 4999.5, voucher: null }) })
    expect(line(found, 'sv')).toBe(
      'Referensen används redan på fakturan med ankomstnummer 1234 (2026-10-03, 4 999,50 kr). Visa fakturan',
    )
    expect(line(found, 'en')).toBe(
      'The reference is already on the invoice with arrival number 1234 (2026-10-03, 4 999,50 kr). View the invoice',
    )
  })

  it('states the amount the invoice list shows: öresavrundning applied when the invoice has it', () => {
    expect(line(reuse({ invoice: invoice({ total: 4999.5, ore_rounding: true }) }), 'sv')).toContain('(2026-10-03, 5 000 kr)')
    expect(line(reuse({ invoice: invoice({ total: 4999.5, ore_rounding: false }) }), 'sv')).toContain('(2026-10-03, 4 999,50 kr)')
  })

  it('states a foreign invoice in its own currency', () => {
    expect(line(reuse({ invoice: invoice({ total: 310, currency: 'EUR' }) }), 'sv')).toContain('310 €')
  })

  it('is one quiet line, with no invoice named, once reuse is the supplier\'s normal', () => {
    const routine = reuse({ count: 3, needs_acknowledgement: false })
    expect(line(routine, 'sv')).toBe('Samma referens finns på 3 tidigare fakturor från leverantören.')
    expect(line(routine, 'en')).toBe('The same reference is on 3 earlier invoices from this supplier.')
    const html = renderInLocale(createElement(ReusedReferenceLine, { reuse: routine }), 'sv')
    expect(html).toContain('text-muted-foreground')
    expect(html).not.toContain('text-attn')
  })
})
