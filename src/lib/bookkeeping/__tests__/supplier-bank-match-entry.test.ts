/**
 * The supplier bank-match verifikat dispatchers: what the dashboard and v1
 * POSTs book (createSupplierBankMatchEntry) is what the preview shows
 * (buildSupplierBankMatchLines), for every booking shape planSupplierBankMatch
 * returns, and every input the plan carries reaches the builder.
 *
 * Runs the real builders; only the engine's two DB-touching functions are
 * mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, SupplierInvoiceItem, Transaction } from '@/types'
import { makeSupplier, makeSupplierInvoice } from '@/tests/helpers'
import type { SupplierBankMatchBooking } from '@/lib/invoices/apply-supplier-payment'

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
  buildSupplierBankMatchLines,
  createSupplierBankMatchEntry,
} from '../supplier-bank-match-entry'

const supabase = {} as never
const transaction: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'> = {
  id: 'tx-1',
  cash_account_id: null,
  date: '2026-09-15',
  amount: -1010,
  currency: 'SEK',
}

const item: SupplierInvoiceItem = {
  id: 'item-1',
  supplier_invoice_id: 'si-1',
  sort_order: 0,
  description: 'Kontorsmaterial',
  quantity: 1,
  unit: 'st',
  unit_price: 800,
  line_total: 800,
  account_number: '6110',
  vat_code: null,
  vat_rate: 0.25,
  vat_amount: 200,
  reverse_charge_rate: null,
  created_at: '2026-09-01T00:00:00Z',
}

const invoice = (overrides = {}) =>
  makeSupplierInvoice({
    subtotal: 800,
    vat_amount: 200,
    total: 1000,
    remaining_amount: 1000,
    registration_journal_entry_id: 'je-registration',
    default_dimensions: { '6': 'P1' },
    supplier: makeSupplier({ name: 'Leverantor AB' }),
    items: [item],
    ...overrides,
  })

type Line = { account_number: string; debit_amount: number; credit_amount: number }
const shape = (lines: Line[]) => lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

async function bookAndPreview(inv: ReturnType<typeof invoice>, booking: SupplierBankMatchBooking) {
  const entry = await createSupplierBankMatchEntry(supabase, 'company-1', 'user-1', {
    invoice: inv,
    booking,
    paymentAccount: '1930',
    transaction,
  })
  expect(entry).not.toBeNull()
  const input = vi.mocked(createJournalEntry).mock.calls[0][3] as CreateJournalEntryInput
  const preview = buildSupplierBankMatchLines(inv, booking, '1930')
  return { input, preview }
}

beforeEach(() => {
  vi.mocked(createJournalEntry).mockClear()
})

describe('createSupplierBankMatchEntry / buildSupplierBankMatchLines', () => {
  it('SEK clearing with a fee on top: 2440 cleared by the debt, the fee on 6570, the preview identical', async () => {
    const { input, preview } = await bookAndPreview(invoice(), {
      kind: 'clearing',
      paymentAmount: 1000,
      sekClearingDebt: 1000,
      bankFeeSek: 10,
    })
    expect(input.source_type).toBe('supplier_invoice_paid')
    expect(input.description).toContain('Leverantor AB')
    expect(input.bank_booking_context).toEqual([expect.objectContaining({ transaction_id: 'tx-1' })])
    expect(shape(input.lines)).toEqual([
      ['2440', 1000, 0],
      ['1930', 0, 1010],
      ['6570', 10, 0],
    ])
    expect(input.lines.every((l) => l.dimensions?.['6'] === 'P1')).toBe(true)
    expect(input.lines).toEqual(preview.lines)
  })

  it('SEK clearing of a whole-krona payment: the öre residual on 3740, the preview identical', async () => {
    const { input, preview } = await bookAndPreview(
      invoice({ total: 1234.44, remaining_amount: 1234.44 }),
      { kind: 'clearing', paymentAmount: 1234, sekClearingDebt: 1234.44, bankFeeSek: 0 },
    )
    expect(shape(input.lines)).toEqual([
      ['2440', 1234.44, 0],
      ['1930', 0, 1234],
      ['3740', 0, 0.44],
    ])
    expect(preview.oreDiffSek).toBe(0.44)
    expect(input.lines).toEqual(preview.lines)
  })

  it('foreign clearing: the kursdifferens and the fee, the preview identical', async () => {
    const { input, preview } = await bookAndPreview(
      invoice({ currency: 'EUR', exchange_rate: 11, total: 100, remaining_amount: 100 }),
      { kind: 'clearing', paymentAmount: 1100, exchangeRateDifference: 50, bankFeeSek: 12 },
    )
    expect(shape(input.lines)).toEqual([
      ['2440', 1100, 0],
      ['1930', 0, 1062],
      ['3960', 0, 50],
      ['6570', 12, 0],
    ])
    expect(input.lines).toEqual(preview.lines)
  })

  it('kontantmetoden: expense and VAT at payment with the fee, the preview identical', async () => {
    const { input, preview } = await bookAndPreview(
      invoice({ registration_journal_entry_id: null }),
      { kind: 'cash', settledBankSek: 1000, bankFeeSek: 10 },
    )
    expect(input.source_type).toBe('supplier_invoice_cash_payment')
    expect(shape(input.lines)).toEqual([
      ['6110', 800, 0],
      ['2641', 200, 0],
      ['1930', 0, 1010],
      ['6570', 10, 0],
    ])
    expect(input.lines).toEqual(preview.lines)
  })
})
