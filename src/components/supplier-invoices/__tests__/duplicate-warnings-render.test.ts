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
  payment: { state: 'unpaid' },
  ...overrides,
})

const reuse = (overrides: Partial<SupplierInvoiceReferenceReuse> = {}): SupplierInvoiceReferenceReuse => ({
  invoice: invoice(),
  count: 1,
  twin: null,
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
    expect(line(twin, 'sv')).toBe('Fakturanummer EX-1042 används redan på verifikat A71. Den är inte betald. Visa fakturan')
    expect(line(twin, 'en')).toBe('Invoice number EX-1042 is already used on verifikat A71. It is not paid. View the invoice')
  })

  it('keeps the sentence without a verifikat while that invoice is not booked', () => {
    const twin = invoice({ supplier_invoice_number: 'EX-1042', voucher: null })
    expect(line(twin, 'sv')).toBe('EX-1042 är redan registrerad för den här leverantören. Den är inte betald. Visa fakturan')
    expect(line(twin, 'en')).toBe('EX-1042 is already registered for this supplier. It is not paid. View the invoice')
  })

  it('links to the invoice in a new tab, so the form is not lost', () => {
    const html = renderInLocale(createElement(DuplicateNumberLine, { number: 'EX-1042', invoice: invoice() }), 'sv')
    expect(html).toContain('href="/supplier-invoices/si-1"')
    expect(html).toContain('target="_blank"')
  })

  it('says whether that invoice is paid: paid on its day, partly paid, in a payment, or not paid', () => {
    const states: Array<[RegisteredSupplierInvoice['payment'], string, string]> = [
      [{ state: 'paid', paid_at: '2026-10-28T09:12:00Z' }, 'Den är betald 2026-10-28.', 'It was paid on 2026-10-28.'],
      [{ state: 'paid', paid_at: null }, 'Den är betald.', 'It is paid.'],
      [{ state: 'partially_paid', paid_amount: 1000 }, 'Den är delbetald: 1 000 kr av 2 185 kr.', 'It is partly paid: 1 000 kr of 2 185 kr.'],
      [{ state: 'in_payment' }, 'Den ligger redan i en betalning.', 'It is already in a payment.'],
      [{ state: 'unpaid' }, 'Den är inte betald.', 'It is not paid.'],
    ]
    for (const [payment, sv, en] of states) {
      const twin = invoice({ supplier_invoice_number: 'EX-1042', voucher: { journal_entry_id: 'je-7', label: 'A71' }, payment })
      expect(line(twin, 'sv')).toBe(`Fakturanummer EX-1042 används redan på verifikat A71. ${sv} Visa fakturan`)
      expect(line(twin, 'en')).toBe(`Invoice number EX-1042 is already used on verifikat A71. ${en} View the invoice`)
    }
  })

  it('states a part payment in the invoice\'s own currency, of the amount the list shows', () => {
    const foreign = invoice({ total: 310, currency: 'EUR', payment: { state: 'partially_paid', paid_amount: 100 } })
    expect(line(foreign, 'sv')).toContain('Den är delbetald: 100 € av 310 €.')
    const rounded = invoice({ total: 4999.5, ore_rounding: true, payment: { state: 'partially_paid', paid_amount: 2000 } })
    expect(line(rounded, 'sv')).toContain('Den är delbetald: 2 000 kr av 5 000 kr.')
  })
})

describe('ReusedReferenceLine', () => {
  const line = (found: SupplierInvoiceReferenceReuse, locale: 'sv' | 'en') =>
    read(renderInLocale(createElement(ReusedReferenceLine, { reuse: found }), locale))

  it('names the other invoice: number, date, amount and verifikat', () => {
    expect(line(reuse(), 'sv')).toBe(
      'Referensen används redan på faktura EX-0990 (2026-10-03, 2 185 kr), verifikat A64. Den är inte betald. Visa fakturan',
    )
    expect(line(reuse(), 'en')).toBe(
      'The reference is already on invoice EX-0990 (2026-10-03, 2 185 kr), verifikat A64. It is not paid. View the invoice',
    )
  })

  it('names an invoice without a number by its ankomstnummer, and no verifikat while it is not booked', () => {
    const found = reuse({ invoice: invoice({ supplier_invoice_number: null, arrival_number: 1234, total: 4999.5, voucher: null }) })
    expect(line(found, 'sv')).toBe(
      'Referensen används redan på fakturan med ankomstnummer 1234 (2026-10-03, 4 999,50 kr). Den är inte betald. Visa fakturan',
    )
    expect(line(found, 'en')).toBe(
      'The reference is already on the invoice with arrival number 1234 (2026-10-03, 4 999,50 kr). It is not paid. View the invoice',
    )
  })

  it('states the amount the invoice list shows: öresavrundning applied when the invoice has it', () => {
    expect(line(reuse({ invoice: invoice({ total: 4999.5, ore_rounding: true }) }), 'sv')).toContain('(2026-10-03, 5 000 kr)')
    expect(line(reuse({ invoice: invoice({ total: 4999.5, ore_rounding: false }) }), 'sv')).toContain('(2026-10-03, 4 999,50 kr)')
  })

  it('states a foreign invoice in its own currency', () => {
    expect(line(reuse({ invoice: invoice({ total: 310, currency: 'EUR' }) }), 'sv')).toContain('310 €')
  })

  it('says that the reused reference\'s invoice is already in a payment', () => {
    const found = reuse({ invoice: invoice({ payment: { state: 'in_payment' } }) })
    expect(line(found, 'sv')).toBe(
      'Referensen används redan på faktura EX-0990 (2026-10-03, 2 185 kr), verifikat A64. Den ligger redan i en betalning. Visa fakturan',
    )
  })

  it('names the same document again as one, with its payment, however many share the reference', () => {
    const twin = invoice({ id: 'si-2', supplier_invoice_number: null, arrival_number: 57, payment: { state: 'paid', paid_at: '2026-11-05T10:00:00Z' } })
    const found = reuse({ count: 3, twin, needs_acknowledgement: true })
    expect(line(found, 'sv')).toBe(
      'Samma referens, datum och belopp finns redan på fakturan med ankomstnummer 57, verifikat A64. Den är betald 2026-11-05. Visa fakturan',
    )
    expect(line(found, 'en')).toBe(
      'The same reference, date and amount are already on the invoice with arrival number 57, verifikat A64. It was paid on 2026-11-05. View the invoice',
    )
    const html = renderInLocale(createElement(ReusedReferenceLine, { reuse: found }), 'sv')
    expect(html).toContain('text-attn')
    expect(html).toContain('href="/supplier-invoices/si-2"')

    const numbered = reuse({ twin: invoice({ voucher: null }), needs_acknowledgement: true })
    expect(line(numbered, 'sv')).toBe('Samma referens, datum och belopp finns redan på faktura EX-0990. Den är inte betald. Visa fakturan')
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
