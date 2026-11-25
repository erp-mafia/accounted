import { describe, expect, it } from 'vitest'
import {
  buildCreditNoteLines,
  buildInvoiceRegistrationLines,
  issueOreRounding,
  type InvoiceRegistrationLinesSource,
} from '@/lib/bookkeeping/invoice-lines'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { registrationOreRounding } from '@/lib/bookkeeping/ore-rounding'
import { getAmountToPay } from '@/lib/bookkeeping/invoice-rounding'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryLineInput, InvoiceItem } from '@/types'

/**
 * The issue verifikat of an invoice with öresavrundning books the receivable
 * the invoice states: 1510 at the rounded "Att betala", the öre on 3740, no
 * moms on it. Before, 1510 carried the exact total and the öre waited for the
 * payment, so the receivable and the result were wrong until then (and in the
 * wrong year across a bokslut).
 */

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Konsult',
    quantity: 1,
    unit: 'st',
    unit_price: 799.8,
    line_total: 799.8,
    vat_rate: 25,
    vat_amount: 199.95,
    ...overrides,
  } as InvoiceItem
}

function invoice(overrides: Partial<InvoiceRegistrationLinesSource> = {}): InvoiceRegistrationLinesSource {
  return {
    id: 'inv-1',
    invoice_number: '1001',
    currency: 'SEK',
    exchange_rate: null,
    vat_treatment: 'standard_25',
    subtotal: 799.8,
    vat_amount: 199.95,
    total: 999.75,
    items: [item()],
    ore_rounding: null,
    ...overrides,
  }
}

function net(lines: CreateJournalEntryLineInput[], account: string): number {
  return roundOre(lines.filter((l) => l.account_number === account).reduce((s, l) => s + l.debit_amount - l.credit_amount, 0))
}

function balanced(lines: CreateJournalEntryLineInput[]): boolean {
  const debit = roundOre(lines.reduce((s, l) => s + l.debit_amount, 0))
  const credit = roundOre(lines.reduce((s, l) => s + l.credit_amount, 0))
  return debit === credit && debit > 0
}

describe('buildInvoiceRegistrationLines: the issue verifikat books the öresavrundning', () => {
  it('999,75 sent as 1 000: Dr 1510 1 000, Cr 3740 0,25, revenue and moms unchanged', () => {
    const lines = buildInvoiceRegistrationLines(invoice(), 'aktiebolag', null, { companyOreRounding: true })
    expect(net(lines, '1510')).toBe(1000)
    expect(net(lines, '3740')).toBe(-0.25)
    expect(net(lines, '3001')).toBe(-799.8)
    expect(net(lines, '2611')).toBe(-199.95)
    expect(balanced(lines)).toBe(true)
    // What the invoice asks the customer to pay is what 1510 carries.
    expect(net(lines, '1510')).toBe(getAmountToPay(invoice(), { ore_rounding: true }).toPay)
  })

  it('1 000,40 sent as 1 000: Dr 1510 1 000, Dr 3740 0,40', () => {
    const inv = invoice({ subtotal: 800.32, vat_amount: 200.08, total: 1000.4, items: [item({ unit_price: 800.32, line_total: 800.32, vat_amount: 200.08 })] })
    const lines = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { companyOreRounding: true })
    expect(net(lines, '1510')).toBe(1000)
    expect(net(lines, '3740')).toBe(0.4)
    expect(balanced(lines)).toBe(true)
  })

  it('ROT/RUT: 1510 is the rounded total less the deduction, 1513 unchanged', () => {
    const rut = invoice({
      subtotal: 670,
      vat_amount: 167.5,
      total: 837.5,
      deduction_total: 418,
      items: [item({ unit_price: 670, line_total: 670, vat_amount: 167.5, deduction_type: 'rut', deduction_amount: 418 })],
    })
    const lines = buildInvoiceRegistrationLines(rut, 'aktiebolag', null, { companyOreRounding: true })
    expect(net(lines, '1513')).toBe(418)
    expect(net(lines, '1510')).toBe(420)
    expect(net(lines, '3740')).toBe(-0.5)
    expect(balanced(lines)).toBe(true)
  })

  it.each([
    ['the company has öresavrundning off', invoice(), false],
    ['the invoice has it off over the company', invoice({ ore_rounding: false }), true],
    ['the caller books the exact total (kontantmetoden year-end carry)', invoice(), undefined],
    ['the total is whole kronor', invoice({ subtotal: 800, vat_amount: 200, total: 1000, items: [item({ unit_price: 800, line_total: 800, vat_amount: 200 })] }), true],
  ])('no 3740 when %s', (_, inv, companyOreRounding) => {
    const lines = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { companyOreRounding })
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(net(lines, '1510')).toBe(inv.total)
  })

  it('a foreign invoice keeps its exact total (öresavrundning is for whole Swedish kronor)', () => {
    const eur = invoice({ currency: 'EUR', exchange_rate: 11.5, subtotal: 79.98, vat_amount: 19.995, total: 99.975, items: [item({ unit_price: 79.98, line_total: 79.98, vat_amount: 19.995 })] })
    const lines = buildInvoiceRegistrationLines(eur, 'aktiebolag', null, { companyOreRounding: true })
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('an invoice of a few kronor keeps its exact total: the doors would read the gap as a rättelse', () => {
    const tiny = invoice({ subtotal: 1.2, vat_amount: 0.3, total: 1.5, items: [item({ unit_price: 1.2, line_total: 1.2, vat_amount: 0.3 })] })
    expect(issueOreRounding(tiny, 1.5, true)).toBe(0)
    const lines = buildInvoiceRegistrationLines(tiny, 'aktiebolag', null, { companyOreRounding: true })
    expect(net(lines, '1510')).toBe(1.5)
  })
})

describe('buildCreditNoteLines: a credit of an original that booked its öresavrundning', () => {
  const credit = invoice({
    id: 'cr-1',
    subtotal: -799.8,
    vat_amount: -199.95,
    total: -999.75,
    items: [item({ unit_price: -799.8, line_total: -799.8, vat_amount: -199.95 })],
  })

  it('takes 1 000 off 1510 and gives the 0,25 back on 3740: the pair nets to zero', () => {
    const original = buildInvoiceRegistrationLines(invoice(), 'aktiebolag', null, { companyOreRounding: true })
    const reversal = buildCreditNoteLines(credit, 'aktiebolag', 'A-1', { companyOreRounding: true })
    expect(net(reversal, '1510')).toBe(-1000)
    expect(net(reversal, '3740')).toBe(0.25)
    expect(balanced(reversal)).toBe(true)
    const both = [...original, ...reversal]
    for (const account of ['1510', '3740', '3001', '2611']) expect(net(both, account)).toBe(0)
  })

  it('an original booked at the exact total is reversed at the exact total', () => {
    const reversal = buildCreditNoteLines(credit, 'aktiebolag', 'A-1')
    expect(net(reversal, '1510')).toBe(-999.75)
    expect(reversal.some((l) => l.account_number === '3740')).toBe(false)
  })
})

describe('the issue öre and the payment: 3740 is booked once, 1510 clears to zero', () => {
  const sek = (amount: number) => ({ amount, amount_sek: null, currency: 'SEK', exchange_rate: null })

  it.each([
    ['999,75 paid with 1 000', invoice(), 1000],
    ['1 000,40 paid with 1 000', invoice({ subtotal: 800.32, vat_amount: 200.08, total: 1000.4, items: [item({ unit_price: 800.32, line_total: 800.32, vat_amount: 200.08 })] }), 1000],
  ])('%s', (_, inv, paid) => {
    const issue = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { companyOreRounding: true })
    const carried = net(issue, '1510')
    const payment = buildInvoicePaymentClearingLines(
      sek(paid),
      { currency: 'SEK', exchange_rate: null, remaining_amount: inv.total, total: inv.total, paid_amount: 0, carried_sek: carried },
      'Inbetalning',
      undefined,
      '1930',
    )
    const all = [...issue, ...payment.lines]
    expect(net(all, '1510')).toBe(0)
    expect(net(all, '1930')).toBe(paid)
    // The whole öresavrundning, once, on the issue verifikat.
    expect(net(all, '3740')).toBe(roundOre(inv.total - paid))
    expect(net(payment.lines, '3740')).toBe(0)
  })
})

describe('registrationOreRounding: what the issue verifikat put on 1510 beyond the receivable', () => {
  it.each([
    [999.75, 1000, 0.25],
    [1000.4, 1000, -0.4],
    [-999.75, -1000, -0.25],
    [999.75, 999.75, 0],
    [999.75, 1500, 0],
    [999.75, null, 0],
  ])('receivable %s, 1510 %s: %s', (receivable, registered, expected) => {
    expect(registrationOreRounding(receivable, registered)).toBe(expected)
  })
})
