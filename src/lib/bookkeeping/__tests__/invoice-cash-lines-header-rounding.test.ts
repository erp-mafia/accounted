/**
 * Kontantmetoden, an invoice whose header total is its rounded amount to pay
 * while its rows carry the öre: an invoice imported from a provider that
 * stores Att betala as the total and folds the öresavrundning into the
 * header net. The cash entry books the bank at what is owed, revenue and
 * moms at the rows, and the invoice's own öresavrundning on 3740, the way
 * the source system booked it. Without that line the entry did not balance
 * and the engine refused it, so the invoice could be neither marked paid
 * nor matched to its payment.
 */
import { describe, it, expect } from 'vitest'
import type { CreateJournalEntryLineInput, Invoice, InvoiceItem } from '@/types'
import { buildInvoiceCashLines } from '../invoice-lines'

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    description: 'Konsulttimmar',
    quantity: 2.5,
    unit: 'h',
    unit_price: 1250,
    line_total: 3125,
    vat_rate: 25,
    vat_amount: 781.25,
    sort_order: 1,
    created_at: '2026-11-25',
    ...overrides,
  }
}

// Rows: 3 125 + 5 000 = 8 125 net, 781,25 + 1 250 = 2 031,25 moms, together
// 10 156,25. Header: the rounded 10 156 to pay, the 0,25 folded into the net
// (8 124,75), the moms as the rows state it.
function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    invoice_number: '2026-017',
    total: 10156,
    total_sek: 10156,
    subtotal: 8124.75,
    subtotal_sek: 8124.75,
    vat_amount: 2031.25,
    vat_amount_sek: 2031.25,
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    items: [
      item(),
      item({ id: 'item-2', quantity: 4, line_total: 5000, vat_amount: 1250, sort_order: 2 }),
    ],
    ...overrides,
  } as Invoice
}

const rows = (lines: CreateJournalEntryLineInput[]) =>
  lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

function balances(lines: CreateJournalEntryLineInput[]): boolean {
  const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
  return Math.round((debit - credit) * 100) === 0 && debit > 0
}

describe('buildInvoiceCashLines on a header total rounded to whole kronor', () => {
  it('marked paid: 1930 the 10 156 owed, revenue and moms the rows, 3740 debits the 0,25', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930')
    expect(rows(lines)).toEqual([
      ['1930', 10156, 0],
      ['3001', 0, 8125],
      ['2611', 0, 2031.25],
      ['3740', 0.25, 0],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('a bank payment 0,06 short: 1930 the bank, the invoice rounding and the bank gap each on a 3740 line', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 10155.94)
    expect(rows(lines)).toEqual([
      ['1930', 10155.94, 0],
      ['3001', 0, 8125],
      ['2611', 0, 2031.25],
      ['3740', 0.25, 0],
      ['3740', 0.06, 0],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('a bank payment 0,90 short: no 3740 line reaches a krona', () => {
    const { lines } = buildInvoiceCashLines(invoice(), 'aktiebolag', undefined, '1930', 10155.1)
    expect(rows(lines)).toEqual([
      ['1930', 10155.1, 0],
      ['3001', 0, 8125],
      ['2611', 0, 2031.25],
      ['3740', 0.25, 0],
      ['3740', 0.9, 0],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('a header rounded up (rows 1 234,56, total 1 235): 3740 credits the 0,44', () => {
    const inv = invoice({
      total: 1235,
      total_sek: 1235,
      subtotal: 988.09,
      subtotal_sek: 988.09,
      vat_amount: 246.91,
      vat_amount_sek: 246.91,
      items: [item({ quantity: 1, unit_price: 987.65, line_total: 987.65, vat_amount: 246.91 })],
    })
    const { lines } = buildInvoiceCashLines(inv, 'aktiebolag', undefined, '1930')
    expect(rows(lines)).toEqual([
      ['1930', 1235, 0],
      ['3001', 0, 987.65],
      ['2611', 0, 246.91],
      ['3740', 0, 0.44],
    ])
    expect(balances(lines)).toBe(true)
  })

  it('a gap of a krona or more is never rounding: no 3740 line', () => {
    const { lines } = buildInvoiceCashLines(invoice({ total: 10155, total_sek: 10155 }), 'aktiebolag', undefined, '1930')
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('a header that is not its rows rounded to whole kronor: no 3740 line', () => {
    const { lines } = buildInvoiceCashLines(invoice({ total: 10156.1, total_sek: 10156.1 }), 'aktiebolag', undefined, '1930')
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('a header whose moms differs from the rows is not rounding of the amount to pay: no 3740 line', () => {
    const { lines } = buildInvoiceCashLines(
      invoice({ subtotal: 8125, subtotal_sek: 8125, vat_amount: 2031, vat_amount_sek: 2031 }),
      'aktiebolag', undefined, '1930',
    )
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('a header that adds up to its rows books no 3740 line', () => {
    const { lines } = buildInvoiceCashLines(
      invoice({ total: 10156.25, total_sek: 10156.25, subtotal: 8125, subtotal_sek: 8125 }),
      'aktiebolag', undefined, '1930',
    )
    expect(rows(lines)).toEqual([
      ['1930', 10156.25, 0],
      ['3001', 0, 8125],
      ['2611', 0, 2031.25],
    ])
  })
})
