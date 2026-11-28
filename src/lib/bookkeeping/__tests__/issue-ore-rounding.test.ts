import { describe, expect, it } from 'vitest'
import {
  buildCreditNoteLines,
  buildInvoiceRegistrationLines,
  issueOreRoundingDelta,
  type InvoiceRegistrationLinesSource,
} from '@/lib/bookkeeping/invoice-lines'
import { buildInvoicePaymentClearingLines } from '@/lib/bookkeeping/invoice-payment-lines'
import { getAmountToPay } from '@/lib/bookkeeping/invoice-rounding'
import { issueBookedOre } from '@/lib/bookkeeping/ledger-carried-sek'
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

const roundedDown = () =>
  invoice({
    subtotal: 800.32,
    vat_amount: 200.08,
    total: 1000.4,
    items: [item({ unit_price: 800.32, line_total: 800.32, vat_amount: 200.08 })],
  })

const ON = { company: { ore_rounding: true } }
const OFF = { company: { ore_rounding: false } }

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
    const lines = buildInvoiceRegistrationLines(invoice(), 'aktiebolag', null, { oreRounding: ON })
    expect(net(lines, '1510')).toBe(1000)
    expect(net(lines, '3740')).toBe(-0.25)
    expect(net(lines, '3001')).toBe(-799.8)
    expect(net(lines, '2611')).toBe(-199.95)
    expect(balanced(lines)).toBe(true)
    // What the invoice asks the customer to pay is what 1510 carries.
    expect(net(lines, '1510')).toBe(getAmountToPay(invoice(), { ore_rounding: true }).toPay)
  })

  it('1 000,40 sent as 1 000: Dr 1510 1 000, Dr 3740 0,40', () => {
    const lines = buildInvoiceRegistrationLines(roundedDown(), 'aktiebolag', null, { oreRounding: ON })
    expect(net(lines, '1510')).toBe(1000)
    expect(net(lines, '3740')).toBe(0.4)
    expect(net(lines, '2611')).toBe(-200.08)
    expect(balanced(lines)).toBe(true)
  })

  it('ROT/RUT keeps the exact total: a refused deduction moves 1513 onto 1510 where no door follows it', () => {
    const rut = invoice({
      subtotal: 670,
      vat_amount: 167.5,
      total: 837.5,
      deduction_total: 418,
      items: [item({ unit_price: 670, line_total: 670, vat_amount: 167.5, deduction_type: 'rut', deduction_amount: 418 })],
    })
    const exact = buildInvoiceRegistrationLines(rut, 'aktiebolag', null)
    const lines = buildInvoiceRegistrationLines(rut, 'aktiebolag', null, { oreRounding: ON })
    expect(lines).toEqual(exact)
    expect(net(lines, '1513')).toBe(418)
    expect(net(lines, '1510')).toBe(419.5)
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(issueOreRoundingDelta(rut, 419.5, ON)).toBe(0)
  })

  it('moms and revenue are the same rows with and without the rounding: only 1510 and 3740 move', () => {
    for (const inv of [invoice(), roundedDown()]) {
      const exact = buildInvoiceRegistrationLines(inv, 'aktiebolag', null)
      const rounded = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { oreRounding: ON })
      const others = (lines: CreateJournalEntryLineInput[]) =>
        lines.filter((l) => l.account_number !== '1510' && l.account_number !== '3740')
      expect(others(rounded)).toEqual(others(exact))
    }
  })

  it.each([
    ['the company has öresavrundning off', invoice(), OFF],
    ['the invoice has it off over the company', invoice({ ore_rounding: false }), ON],
    ['the caller books the exact total (kontantmetoden year-end carry)', invoice(), undefined],
    ['a received självfaktura states the buyer\'s amount', invoice({ is_self_billed: true }), ON],
    ['the total is whole kronor', invoice({ subtotal: 800, vat_amount: 200, total: 1000, items: [item({ unit_price: 800, line_total: 800, vat_amount: 200 })] }), ON],
  ])('no 3740 when %s', (_, inv, oreRounding) => {
    const lines = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { oreRounding })
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(net(lines, '1510')).toBe(inv.total)
  })

  it('the invoice\'s own choice wins over the company setting, and no setting at all is on', () => {
    expect(net(buildInvoiceRegistrationLines(invoice({ ore_rounding: true }), 'aktiebolag', null, { oreRounding: OFF }), '1510')).toBe(1000)
    expect(net(buildInvoiceRegistrationLines(invoice(), 'aktiebolag', null, { oreRounding: { company: null } }), '1510')).toBe(1000)
  })

  it('a foreign invoice keeps its exact total (öresavrundning is for whole Swedish kronor)', () => {
    const eur = invoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 79.98,
      vat_amount: 19.99,
      total: 99.97,
      items: [item({ unit_price: 79.98, line_total: 79.98, vat_amount: 19.99 })],
    })
    const exact = buildInvoiceRegistrationLines(eur, 'aktiebolag', null)
    const lines = buildInvoiceRegistrationLines(eur, 'aktiebolag', null, { oreRounding: ON })
    expect(lines.some((l) => l.account_number === '3740')).toBe(false)
    expect(lines).toEqual(exact)
  })

  it('an invoice of a few kronor keeps its exact total: the doors would read the gap as a rättelse', () => {
    const tiny = invoice({ subtotal: 1.2, vat_amount: 0.3, total: 1.5, items: [item({ unit_price: 1.2, line_total: 1.2, vat_amount: 0.3 })] })
    expect(issueOreRoundingDelta(tiny, 1.5, ON)).toBe(0)
    const lines = buildInvoiceRegistrationLines(tiny, 'aktiebolag', null, { oreRounding: ON })
    expect(net(lines, '1510')).toBe(1.5)
  })
})

describe('buildCreditNoteLines: a credit of an original that booked its öresavrundning', () => {
  const credit = (overrides: Partial<InvoiceRegistrationLinesSource> = {}) =>
    invoice({
      id: 'cr-1',
      subtotal: -799.8,
      vat_amount: -199.95,
      total: -999.75,
      items: [item({ unit_price: -799.8, line_total: -799.8, vat_amount: -199.95 })],
      ...overrides,
    })

  it('takes 1 000 off 1510 and gives the 0,25 back on 3740: the pair nets to zero', () => {
    const original = buildInvoiceRegistrationLines(invoice(), 'aktiebolag', null, { oreRounding: ON })
    const reversal = buildCreditNoteLines(credit(), 'aktiebolag', 'A-1', { oreRounding: { mirror: 0.25 } })
    expect(net(reversal, '1510')).toBe(-1000)
    expect(net(reversal, '3740')).toBe(0.25)
    expect(balanced(reversal)).toBe(true)
    const both = [...original, ...reversal]
    for (const account of ['1510', '3740', '3001', '2611']) expect(net(both, account)).toBe(0)
  })

  it('rounded down: the credit takes 1 000 off 1510 and credits the 0,40 back', () => {
    const original = buildInvoiceRegistrationLines(roundedDown(), 'aktiebolag', null, { oreRounding: ON })
    const reversal = buildCreditNoteLines(
      credit({ subtotal: -800.32, vat_amount: -200.08, total: -1000.4, items: [item({ unit_price: -800.32, line_total: -800.32, vat_amount: -200.08 })] }),
      'aktiebolag',
      'A-1',
      { oreRounding: { mirror: -0.4 } },
    )
    const both = [...original, ...reversal]
    for (const account of ['1510', '3740', '3001', '2611']) expect(net(both, account)).toBe(0)
  })

  it('takes back exactly what the original booked, not what rounding its total would give', () => {
    // An imported or hand-edited original: 1 000,50 booked at 1 000 with Dr
    // 3740 0,50 (rounding its total would give 1 001).
    const originalLines = [
      { account_number: '1510', debit_amount: 1000, credit_amount: 0 },
      { account_number: '3740', debit_amount: 0.5, credit_amount: 0 },
      { account_number: '3001', debit_amount: 0, credit_amount: 800.4 },
      { account_number: '2611', debit_amount: 0, credit_amount: 200.1 },
    ] as CreateJournalEntryLineInput[]
    const reversal = buildCreditNoteLines(
      credit({ subtotal: -800.4, vat_amount: -200.1, total: -1000.5, items: [item({ unit_price: -800.4, line_total: -800.4, vat_amount: -200.1 })] }),
      'aktiebolag',
      'A-1',
      { oreRounding: { mirror: -0.5 } },
    )
    expect(net(reversal, '1510')).toBe(-1000)
    expect(balanced(reversal)).toBe(true)
    const both = [...originalLines, ...reversal]
    for (const account of ['1510', '3740', '3001', '2611']) expect(net(both, account)).toBe(0)
  })

  it('mirrors even when the credit\'s own flag or the company setting is off today', () => {
    const reversal = buildCreditNoteLines(credit({ ore_rounding: false }), 'aktiebolag', 'A-1', { oreRounding: { mirror: 0.25 } })
    expect(net(reversal, '1510')).toBe(-1000)
    expect(net(reversal, '3740')).toBe(0.25)
  })

  it('an original booked at the exact total is reversed at the exact total', () => {
    const reversal = buildCreditNoteLines(credit({ ore_rounding: true }), 'aktiebolag', 'A-1')
    expect(net(reversal, '1510')).toBe(-999.75)
    expect(reversal.some((l) => l.account_number === '3740')).toBe(false)
  })
})

describe('the issue öre and the payment: 3740 is booked once, 1510 clears to zero', () => {
  const sek = (amount: number) => ({ amount, amount_sek: null, currency: 'SEK', exchange_rate: null })

  it.each([
    ['999,75 paid with 1 000', invoice(), 1000],
    ['1 000,40 paid with 1 000', roundedDown(), 1000],
    ['999,75 paid with the exact total', invoice(), 999.75],
  ])('%s', (_, inv, paid) => {
    const issue = buildInvoiceRegistrationLines(inv, 'aktiebolag', null, { oreRounding: ON })
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
    // The whole öresavrundning, once: what the customer paid off the exact total.
    expect(net(all, '3740')).toBe(roundOre(inv.total - paid))
    if (paid === 1000) expect(net(payment.lines, '3740')).toBe(0)
  })
})

describe('issueBookedOre: what the issue verifikat put on 1510 beyond the customer share', () => {
  it.each([
    [999.75, 0, 1000, 0.25],
    [1000.4, 0, 1000, -0.4],
    [-999.75, 0, -1000, -0.25],
    // ROT/RUT reads as before, whatever its verifikat booked.
    [837.5, 418, 420, 0],
    [837.5, 418, 419.5, 0],
    [999.75, 0, 999.75, 0],
    [999.75, 0, 1500, 0],
    [999.75, 0, null, 0],
  ])('total %s, deduction %s, 151x %s: %s', (total, deduction, registered, expected) => {
    expect(issueBookedOre({ currency: 'SEK', total, deduction_total: deduction }, registered)).toBe(expected)
  })

  it('a foreign document never has one', () => {
    expect(issueBookedOre({ currency: 'EUR', total: 99.75, deduction_total: 0 }, 100)).toBe(0)
  })
})
