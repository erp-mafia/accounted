/**
 * #2852: kontantmetoden supplier payment and öresavrundning.
 *
 * A SEK supplier invoice with display-only öresavrundning tells the user to
 * pay whole kronor, but the cash entry credited the payment account with the
 * exact öre total and booked no 3740 line, so the booked bank account drifted
 * from the real bank row by up to 50 öre per invoice.
 *
 * Runs the real builder (nothing in lib/bookkeeping is mocked except the
 * engine's two DB-touching functions).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, SupplierInvoiceItem } from '@/types'
import { makeSupplierInvoice } from '@/tests/helpers'
import { roundOre, sumOre } from '@/lib/money'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(
    async (_db: unknown, _company: string, _user: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
    }),
  ),
}))

import { createJournalEntry } from '../engine'
import {
  buildSupplierInvoiceCashLines,
  createSupplierCreditNoteEntry,
  createSupplierInvoiceCashEntry,
} from '../supplier-invoice-entries'

function item(overrides: Partial<SupplierInvoiceItem>): SupplierInvoiceItem {
  return {
    id: 'item-1',
    supplier_invoice_id: 'si-1',
    sort_order: 0,
    description: 'Kontorsmaterial',
    quantity: 1,
    unit: 'st',
    unit_price: 0,
    line_total: 0,
    account_number: '6110',
    vat_code: null,
    vat_rate: 0.25,
    vat_amount: 0,
    reverse_charge_rate: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

/** 987,65 + 246,91 moms = 1 234,56: rounds UP to 1 235. */
const itemsUp = [item({ line_total: 987.65, unit_price: 987.65, vat_amount: 246.91 })]
const invoiceUp = (overrides = {}) =>
  makeSupplierInvoice({
    subtotal: 987.65, vat_amount: 246.91, total: 1234.56, remaining_amount: 1234.56,
    ore_rounding: true, ...overrides,
  })

/** 987,55 + 246,89 moms = 1 234,44: rounds DOWN to 1 234. */
const itemsDown = [item({ line_total: 987.55, unit_price: 987.55, vat_amount: 246.89 })]
const invoiceDown = (overrides = {}) =>
  makeSupplierInvoice({
    subtotal: 987.55, vat_amount: 246.89, total: 1234.44, remaining_amount: 1234.44,
    ore_rounding: true, ...overrides,
  })

const find = (lines: CreateJournalEntryLineInput[], account: string) =>
  lines.filter((l) => l.account_number === account)
const balance = (lines: CreateJournalEntryLineInput[]) =>
  roundOre(sumOre(lines.map((l) => l.debit_amount)) - sumOre(lines.map((l) => l.credit_amount)))

beforeEach(() => vi.clearAllMocks())

describe('buildSupplierInvoiceCashLines: öresavrundning without a bank row (mark-paid doors)', () => {
  it('rounded UP: credits the payment account with the whole kronor the user paid and debits 3740', () => {
    const built = buildSupplierInvoiceCashLines(invoiceUp(), itemsUp, 'swedish_business')
    expect(find(built.lines, '6110')[0].debit_amount).toBe(987.65)
    expect(find(built.lines, '2641')[0].debit_amount).toBe(246.91)
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1235)
    expect(find(built.lines, '3740')).toEqual([
      expect.objectContaining({ debit_amount: 0.44, credit_amount: 0, line_description: 'Öresavrundning' }),
    ])
    expect(built.bankSek).toBe(1235)
    expect(built.oreDiffSek).toBe(-0.44)
    expect(balance(built.lines)).toBe(0)
  })

  it('rounded DOWN: credits the whole kronor and credits 3740', () => {
    const built = buildSupplierInvoiceCashLines(invoiceDown(), itemsDown, 'swedish_business')
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1234)
    expect(find(built.lines, '3740')).toEqual([
      expect.objectContaining({ debit_amount: 0, credit_amount: 0.44 }),
    ])
    expect(built.oreDiffSek).toBe(0.44)
    expect(balance(built.lines)).toBe(0)
  })

  it('3740 carries no VAT: expense and input VAT are the exact invoice figures, untouched by the rounding', () => {
    const rounded = buildSupplierInvoiceCashLines(invoiceUp(), itemsUp, 'swedish_business')
    const exact = buildSupplierInvoiceCashLines(invoiceUp({ ore_rounding: false }), itemsUp, 'swedish_business')
    for (const account of ['6110', '2641']) {
      expect(find(rounded.lines, account)).toEqual(find(exact.lines, account))
    }
  })

  it.each([
    ['flag off', { ore_rounding: false }],
    ['flag null (supplier invoices have no company-wide setting)', { ore_rounding: null }],
  ])('%s: byte-identical to before, exact öre and no 3740 line', (_label, overrides) => {
    const built = buildSupplierInvoiceCashLines(invoiceUp(overrides), itemsUp, 'swedish_business')
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1234.56)
    expect(find(built.lines, '3740')).toEqual([])
    expect(built.oreDiffSek).toBe(0)
    expect(built.lines).toHaveLength(3)
  })

  it('an invoice whose rounding is already an item on 3740 (#2849) is not rounded a second time', () => {
    const items = [
      ...itemsUp,
      item({ id: 'item-2', description: 'Öresavrundning', account_number: '3740', vat_rate: 0, line_total: 0.44, unit_price: 0.44 }),
    ]
    const built = buildSupplierInvoiceCashLines(
      invoiceUp({ subtotal: 988.09, total: 1235, remaining_amount: 1235 }),
      items,
      'swedish_business',
    )
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1235)
    // Exactly one 3740 line: the item's own.
    expect(find(built.lines, '3740')).toEqual([
      expect.objectContaining({ debit_amount: 0.44, credit_amount: 0 }),
    ])
    expect(built.oreDiffSek).toBe(0)
    expect(balance(built.lines)).toBe(0)
  })

  it('reverse charge: the fiktiv moms pair nets out and the residual still lands on 3740', () => {
    const items = [item({ line_total: 1000.4, unit_price: 1000.4, vat_rate: 0, reverse_charge_rate: 0.25 })]
    const invoice = makeSupplierInvoice({
      subtotal: 1000.4, vat_amount: 0, total: 1000.4, remaining_amount: 1000.4,
      reverse_charge: true, vat_treatment: 'reverse_charge', ore_rounding: true,
    })
    const built = buildSupplierInvoiceCashLines(invoice, items, 'swedish_business')
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1000)
    expect(find(built.lines, '3740')[0].credit_amount).toBe(0.4)
    expect(balance(built.lines)).toBe(0)
  })

  it('stamps the invoice default dimensions on the 3740 leg like every other leg', () => {
    const built = buildSupplierInvoiceCashLines(
      invoiceUp({ default_dimensions: { '1': 'KS1' } }),
      itemsUp,
      'swedish_business',
    )
    expect(find(built.lines, '3740')[0].dimensions).toEqual({ '1': 'KS1' })
  })
})

describe('buildSupplierInvoiceCashLines: öresavrundning with a known bank row (match doors)', () => {
  it('the bank row decides: a whole-krona row books 3740 even when the flag is off', () => {
    const built = buildSupplierInvoiceCashLines(
      invoiceUp({ ore_rounding: false }), itemsUp, 'swedish_business',
      { settledBankSek: 1235, paymentAccount: '1940' },
    )
    expect(find(built.lines, '1940')[0].credit_amount).toBe(1235)
    expect(find(built.lines, '3740')[0].debit_amount).toBe(0.44)
    expect(balance(built.lines)).toBe(0)
  })

  it('an exact-öre bank row books no 3740 even when the flag is on', () => {
    const built = buildSupplierInvoiceCashLines(invoiceUp(), itemsUp, 'swedish_business', {
      settledBankSek: 1234.56,
    })
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1234.56)
    expect(find(built.lines, '3740')).toEqual([])
  })

  it('a row a krona or more off is never rounding: the exact debt is booked, as before', () => {
    const built = buildSupplierInvoiceCashLines(invoiceUp(), itemsUp, 'swedish_business', {
      settledBankSek: 1300,
    })
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1234.56)
    expect(find(built.lines, '3740')).toEqual([])
  })

  it('foreign invoices are untouched: pinned to the payment-date rate, no 3740', () => {
    const items = [item({ line_total: 100.5, unit_price: 100.5, vat_rate: 0 })]
    const invoice = makeSupplierInvoice({
      currency: 'EUR', exchange_rate: 11, subtotal: 100.5, vat_amount: 0, total: 100.5,
      remaining_amount: 100.5, vat_treatment: 'export', ore_rounding: true,
    })
    const built = buildSupplierInvoiceCashLines(invoice, items, 'non_eu_business', {
      settledBankSek: 1120,
    })
    expect(find(built.lines, '1930')[0].credit_amount).toBe(1120)
    expect(find(built.lines, '3740')).toEqual([])
    expect(built.oreDiffSek).toBe(0)
    expect(balance(built.lines)).toBe(0)
  })
})

describe('createSupplierInvoiceCashEntry', () => {
  it('posts exactly the lines the pure builder returns (what the previews show)', async () => {
    const built = buildSupplierInvoiceCashLines(invoiceUp(), itemsUp, 'swedish_business', {
      supplierName: 'Leverantören AB', paymentAccount: '1940',
    })
    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoiceUp(), itemsUp, '2026-09-21',
      'swedish_business', 'Leverantören AB', '1940',
    )
    const input = vi.mocked(createJournalEntry).mock.calls[0][3]
    expect(input.lines).toEqual(built.lines)
    expect(input.description).toBe(built.description)
    expect(input.source_type).toBe('supplier_invoice_cash_payment')
    expect(find(input.lines, '1940')[0].credit_amount).toBe(1235)
    expect(find(input.lines, '3740')[0].debit_amount).toBe(0.44)
  })
})

describe('credit notes are deliberately unchanged', () => {
  it('a credit note of a display-rounded invoice reverses the exact invoice and books no 3740', async () => {
    // The kreditfaktura reverses what the invoice says, to the öre. Any öre
    // residual on the supplier's actual refund is settled when that refund is
    // booked, not guessed here.
    await createSupplierCreditNoteEntry(
      null as never, 'company-1', 'user-1',
      invoiceUp({ is_credit_note: true, status: 'credited' }), itemsUp, 'swedish_business',
    )
    const lines = vi.mocked(createJournalEntry).mock.calls[0][3].lines
    expect(find(lines, '3740')).toEqual([])
    expect(find(lines, '2440')[0].debit_amount).toBe(1234.56)
    expect(balance(lines)).toBe(0)
  })
})
