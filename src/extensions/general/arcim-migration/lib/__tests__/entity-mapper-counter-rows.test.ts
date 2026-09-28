/**
 * A migrated supplier invoice's rows are its own kontering, never the voucher
 * legs the booking engine writes itself.
 *
 * Visma and Fortnox send a supplier invoice as its registration voucher's
 * rows: cost and VAT against the 2440 payable. The importer stored every row
 * as a supplier_invoice_items row, and every booking path debits each row and
 * writes the payable leg itself, so a kontantmetod payment of a Visma invoice
 * credited the bank twice the invoice and debited 2440, and the same payment
 * of a Fortnox invoice credited 2440 instead of the bank.
 *
 * These tests run the real provider mappers, the real importer mapper and the
 * real kontantmetod line builder (only the engine's two DB-touching functions
 * are mocked), from the row shapes production holds.
 */
import { describe, it, expect, vi } from 'vitest'
import type { CreateJournalEntryInput, CreateJournalEntryLineInput, SupplierInvoice, SupplierInvoiceItem } from '@/types'
import type { SupplierInvoiceDto } from '@/lib/providers/dto'
import { makeSupplierInvoice } from '@/tests/helpers'

vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(
    async (_db: unknown, _company: string, _user: string, input: CreateJournalEntryInput) => ({ id: 'entry-1', ...input }),
  ),
}))

import { buildSupplierInvoiceCashLines } from '@/lib/bookkeeping/supplier-invoice-entries'
import { mapVismaToSupplierInvoice } from '@/lib/providers/visma/mapper'
import { mapFortnoxToSupplierInvoice } from '@/lib/providers/fortnox/mapper'
import { mapSupplierInvoice } from '../entity-mapper'

const map = (dto: SupplierInvoiceDto) => mapSupplierInvoice(dto, 'user-1', 'company-1', 'supplier-1')

/** A Visma SupplierInvoiceApi payload: `Rows` are debit/credit accounting rows. */
function visma(rows: [number, number, number][], over: Record<string, unknown> = {}) {
  const total = rows.find(([account]) => String(account).startsWith('244'))
  return mapVismaToSupplierInvoice({
    Id: 'v-1', InvoiceNumber: '5530', InvoiceDate: '2026-06-01', DueDate: '2026-06-30', CurrencyCode: 'SEK',
    TotalAmount: total ? total[2] - total[1] : 0, PaymentStatus: 3, SupplierName: 'Leverantör AB',
    Rows: rows.map(([account, debit, credit], i) => ({ LineNumber: i + 1, AccountNumber: account, DebetAmount: debit, CreditAmount: credit })),
    ...over,
  })
}

/** A Fortnox SupplierInvoice payload: `SupplierInvoiceRows` carry a signed Total. */
function fortnox(rows: [number, number][], over: Record<string, unknown> = {}) {
  return mapFortnoxToSupplierInvoice({
    GivenNumber: '311', SupplierName: 'Leverantör AB', InvoiceDate: '2026-06-01', DueDate: '2026-06-30',
    Currency: 'SEK', Booked: true, Cancelled: false, Balance: 1250, Total: 1250,
    SupplierInvoiceRows: rows.map(([account, total]) => ({ Account: account, Total: total })),
    ...over,
  })
}

// `+ 0` folds the -0 a credit row's 0 % VAT computes to: numeric stores no
// negative zero, so the database row holds 0 either way.
const rowsOf = (items: Record<string, unknown>[]) =>
  items.map((item) => [item.account_number, item.line_total, Number(item.vat_rate) + 0, Number(item.vat_amount) + 0])

/** What a kontantmetod payment from the bank books for the mapped invoice. */
function cashPayment(mapped: ReturnType<typeof map>, paymentAccount = '1930'): CreateJournalEntryLineInput[] {
  const invoice = makeSupplierInvoice(mapped.invoice as Partial<SupplierInvoice>)
  const items = mapped.items.map((row, i) => ({
    id: `item-${i + 1}`, supplier_invoice_id: invoice.id, created_at: '2026-06-01T00:00:00Z',
    vat_code: null, reverse_charge_rate: null, ...row,
  })) as unknown as SupplierInvoiceItem[]
  return buildSupplierInvoiceCashLines(invoice, items, 'swedish_business', {
    paymentAccount,
    settledBankSek: invoice.total,
  }).lines
}

const sides = (lines: CreateJournalEntryLineInput[]) =>
  lines
    .filter((l) => l.debit_amount !== 0 || l.credit_amount !== 0)
    .map((l) => [l.account_number, l.debit_amount, l.credit_amount])

describe('mapSupplierInvoice: the voucher legs of a provider supplier invoice', () => {
  it('Visma: drops the 2440 row, keeps cost and VAT as rows, and the payment credits the bank once', () => {
    const mapped = map(visma([[6530, 1000, 0], [2641, 250, 0], [2440, 0, 1250]]))

    expect(rowsOf(mapped.items)).toEqual([['6530', 1000, 0, 0], ['2641', 250, 0, 0]])
    expect(mapped.rowsMismatch).toBe(false)
    // The header is what it was: no VAT total in the payload, so gross as net.
    expect(mapped.invoice).toMatchObject({ total: 1250, subtotal: 1250, vat_amount: 0 })
    expect(sides(cashPayment(mapped, '1950'))).toEqual([
      ['6530', 1000, 0],
      ['2641', 250, 0],
      ['1950', 0, 1250],
    ])
  })

  it('Fortnox: drops the signed 2440 row, and the payment credits the bank rather than 2440', () => {
    const mapped = map(fortnox([[2440, -1250], [2640, 250], [6540, 1000]]))

    expect(rowsOf(mapped.items)).toEqual([['2640', 250, 0, 0], ['6540', 1000, 0, 0]])
    expect(sides(cashPayment(mapped))).toEqual([
      ['2640', 250, 0],
      ['6540', 1000, 0],
      ['1930', 0, 1250],
    ])
  })

  it('a pension invoice keeps its särskild löneskatt pair on both sides, and the pair nets out of the payment', () => {
    // 5 000 kr premium, SLP 24.26 % booked 7533 D / 2514 K by the source.
    const mapped = map(visma([[7410, 5000, 0], [7533, 1213, 0], [2514, 0, 1213], [2440, 0, 5000]]))

    expect(rowsOf(mapped.items)).toEqual([['7410', 5000, 0, 0], ['7533', 1213, 0, 0], ['2514', -1213, 0, 0]])
    expect(mapped.items.every((item) => item.apply_slp === undefined)).toBe(true)
    expect(sides(cashPayment(mapped))).toEqual([
      ['7410', 5000, 0],
      ['7533', 1213, 0],
      ['2514', 0, 1213],
      ['1930', 0, 5000],
    ])
  })

  it('a reverse-charge purchase keeps the source\'s fiktiv moms pair', () => {
    const mapped = map(fortnox([[2440, -1840], [5420, 1840], [2645, 460], [2614, -460]], { Total: 1840, Balance: 1840 }))

    expect(rowsOf(mapped.items)).toEqual([['5420', 1840, 0, 0], ['2645', 460, 0, 0], ['2614', -460, 0, 0]])
    expect(sides(cashPayment(mapped))).toEqual([
      ['5420', 1840, 0],
      ['2645', 460, 0],
      ['2614', 0, 460],
      ['1930', 0, 1840],
    ])
  })

  it('keeps an öresavrundning credit a credit', () => {
    const mapped = map(visma([[4000, 719.52, 0], [2641, 179.88, 0], [3740, 0, 0.40], [2440, 0, 899]]))

    expect(rowsOf(mapped.items)).toEqual([['4000', 719.52, 0, 0], ['2641', 179.88, 0, 0], ['3740', -0.40, 0, 0]])
    expect(mapped.rowsMismatch).toBe(false)
  })

  it('stores no rows, and says so, when the rows do not add up to the invoice', () => {
    // The cost row is missing: what is left is 250 kr of a 1 250 kr invoice.
    const mapped = map(fortnox([[2440, -1250], [2641, 250]]))

    expect(mapped.items).toEqual([])
    expect(mapped.rowsMismatch).toBe(true)
    expect(mapped.invoice).toMatchObject({ total: 1250, remaining_amount: 1250 })
  })

  it('says so when the payable was the only row, rather than passing as an invoice without rows', () => {
    const mapped = map(fortnox([[2440, -1250]]))

    expect(mapped.items).toEqual([])
    expect(mapped.rowsMismatch).toBe(true)
  })

  it('keeps a reverse-charge pair when the provider states 0 kr of VAT, which carries neither leg', () => {
    const mapped = map(visma([[5420, 1840, 0], [2645, 460, 0], [2614, 0, 460], [2440, 0, 1840]], { TotalVatAmount: 0 }))

    expect(mapped.rowsMismatch).toBe(false)
    expect(rowsOf(mapped.items)).toEqual([['5420', 1840, 0, 0], ['2645', 460, 0, 0], ['2614', -460, 0, 0]])
    expect(sides(cashPayment(mapped))).toEqual([
      ['5420', 1840, 0],
      ['2645', 460, 0],
      ['2614', 0, 460],
      ['1930', 0, 1840],
    ])
  })

  it('holds rows to the invoice even when no VAT was established, where the job worker never looked', () => {
    // A true invoice line priced net, beside a header that states no VAT:
    // 1 000 kr of rows for a 1 250 kr payable.
    const mapped = map(fortnox([[5410, 1000]]))

    expect(mapped.vatUnresolved).toBe(true)
    expect(mapped.rowsMismatch).toBe(true)
    expect(mapped.items).toEqual([])
  })

  it('drops the VAT row as well when the provider states the VAT elsewhere, so it is posted once', () => {
    const mapped = map(visma([[6530, 1000, 0], [2641, 250, 0], [2440, 0, 1250]], { TotalVatAmount: 250 }))

    expect(mapped.invoice).toMatchObject({ subtotal: 1000, vat_amount: 250, total: 1250 })
    expect(rowsOf(mapped.items)).toEqual([['6530', 1000, 0.25, 250]])
    expect(sides(cashPayment(mapped))).toEqual([
      ['6530', 1000, 0],
      ['2641', 250, 0],
      ['1930', 0, 1250],
    ])
  })

  it('leaves an ordinary invoice line untouched', () => {
    const mapped = map(fortnox([[5410, 1000]], {
      SupplierInvoiceRows: [{ Account: 5410, Total: 1000, VAT: 25, Price: 500, Quantity: 2, Description: 'Kontorsstolar' }],
    }))

    expect(mapped.rowsMismatch).toBe(false)
    expect(mapped.items).toEqual([expect.objectContaining({
      description: 'Kontorsstolar', quantity: 2, unit_price: 500, line_total: 1000, account_number: '5410', vat_rate: 0.25, vat_amount: 250,
    })])
  })

  it('a kreditfaktura stores its own rows in magnitudes, the payable dropped', () => {
    const mapped = map(visma([[2440, 1250, 0], [4010, 0, 1000], [2641, 0, 250]], { IsCreditInvoice: true, PaymentStatus: 6 }))

    expect(mapped.invoice).toMatchObject({ is_credit_note: true, total: 1250 })
    expect(rowsOf(mapped.items)).toEqual([['4010', 1000, 0, 0], ['2641', 250, 0, 0]])
    expect(mapped.rowsMismatch).toBe(false)
  })
})
