import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CreateJournalEntryInput, Invoice, InvoiceItem } from '@/types'

// Only the engine is mocked: the real line builders (createInvoiceCashEntry,
// createInvoicePaymentJournalEntry) run, so these tests pin the verifikat a
// kontantfaktura actually posts (crm#1281).
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: vi.fn(),
}))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({
  clearSettledInvoiceSuggestions: vi.fn(),
}))
// The sale-first rule (defer_invoice_booking) has its own suites
// (lib/invoices/__tests__/settle-invoice-payment-sale-first.test.ts pins
// that a kontantfaktura books no sale first); here no invoice needs one.
vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))

import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { eventBus } from '@/lib/events'

const item = {
  id: 'item-1',
  invoice_id: 'inv-1',
  sort_order: 0,
  description: 'Konsulttimme',
  quantity: 1,
  unit: 'st',
  unit_price: 1000,
  line_total: 1000,
  vat_rate: 25,
  vat_amount: 250,
} as InvoiceItem

/** A just-issued faktura with no verifikat of its own: 1 000 kr + 25 % moms. */
function issuedUnbooked(overrides: Partial<Invoice> = {}) {
  return {
    ...makeInvoice({
      id: 'inv-1',
      invoice_number: '1042',
      invoice_date: '2026-10-17',
      status: 'sent',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      remaining_amount: 1250,
      paid_amount: 0,
    }),
    journal_entry_id: null,
    items: [item],
    customer: { name: 'Kund AB' },
    ...overrides,
  } as Invoice & { customer?: { name?: string | null } | null }
}

function settle(accountingMethod: 'accrual' | 'cash', invoice = issuedUnbooked(), recognizeSaleAtPayment = true) {
  return settleInvoicePayment(
    createQueuedMockSupabaseWithRows().supabase as unknown as SupabaseClient,
    'company-1',
    'user-1',
    {
      invoice,
      paymentAmountInInvoiceCurrency: 1250,
      paymentDate: '2026-10-17',
      accountingMethod,
      entityType: 'enskild_firma',
      settlementAccountNumber: '1940',
      paymentSource: 'manual',
      recognizeSaleAtPayment,
    },
  )
}

function createQueuedMockSupabaseWithRows() {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: { id: 'ip-1' }, error: null }) // invoice_payments insert
  mock.enqueue({ data: [{ id: 'inv-1' }] }) // CAS update to paid
  return mock
}

function postedInput(): CreateJournalEntryInput {
  const calls = vi.mocked(createJournalEntry).mock.calls
  expect(calls).toHaveLength(1)
  return calls[0][3] as CreateJournalEntryInput
}

function shape(input: CreateJournalEntryInput) {
  return input.lines
    .map((line) => ({ account: line.account_number, debit: line.debit_amount, credit: line.credit_amount }))
    .sort((a, b) => a.account.localeCompare(b.account))
}

describe('settleInvoicePayment: the kontantfaktura (paid at issue, crm#1281)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-2026')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-cash' } as never)
  })

  it.each(['accrual', 'cash'] as const)(
    'books one cash verifikat under %s: 19xx debit against revenue and output VAT, no 1510',
    async (method) => {
      const result = await settle(method)

      expect(result).toMatchObject({ ok: true, newStatus: 'paid', newRemaining: 0, journalEntryId: 'je-cash' })
      const input = postedInput()
      expect(input).toMatchObject({
        entry_date: '2026-10-17',
        source_type: 'invoice_cash_payment',
        source_id: 'inv-1',
      })
      expect(shape(input)).toEqual([
        { account: '1940', debit: 1250, credit: 0 },
        { account: '2611', debit: 0, credit: 250 },
        { account: '3001', debit: 0, credit: 1000 },
      ])
    },
  )

  it('regression: without the flag a faktureringsmetoden payment still clears 1510', async () => {
    const result = await settle('accrual', issuedUnbooked(), false)

    expect(result).toMatchObject({ ok: true, newStatus: 'paid' })
    const input = postedInput()
    expect(input.source_type).toBe('invoice_paid')
    expect(shape(input)).toEqual([
      { account: '1510', debit: 0, credit: 1250 },
      { account: '1940', debit: 1250, credit: 0 },
    ])
  })

  it('never books the sale twice: an invoice with its own verifikat clears 1510 even with the flag', async () => {
    const result = await settle('accrual', issuedUnbooked({ journal_entry_id: 'je-registration' } as Partial<Invoice>))

    expect(result).toMatchObject({ ok: true })
    const input = postedInput()
    expect(input.source_type).toBe('invoice_paid')
    expect(shape(input).map((line) => line.account)).toEqual(['1510', '1940'])
  })

  it('refuses a part payment under faktureringsmetoden too: the cash entry books the whole invoice', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      invoice: issuedUnbooked(),
      paymentAmountInInvoiceCurrency: 500,
      paymentDate: '2026-10-17',
      accountingMethod: 'accrual',
      entityType: 'enskild_firma',
      settlementAccountNumber: '1930',
      recognizeSaleAtPayment: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED' })
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
  })
})
