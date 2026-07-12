import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeInvoice } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Invoice } from '@/types'

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoicePaymentJournalEntry: vi.fn(),
  createInvoiceCashEntry: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  cancelOrphanedPaymentEntry: vi.fn(),
}))

import {
  createInvoicePaymentJournalEntry,
  createInvoiceCashEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { cancelOrphanedPaymentEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { settleInvoicePayment } from '@/lib/invoices/settle-invoice-payment'
import { eventBus } from '@/lib/events'

function payableInvoice(overrides: Partial<Invoice> = {}) {
  return {
    ...makeInvoice({ id: 'inv-1', status: 'sent', total: 1250, currency: 'SEK' }),
    remaining_amount: 1250,
    paid_amount: 0,
    customer: { name: 'Kund AB' },
    ...overrides,
  } as Invoice & { customer?: { name?: string | null } | null }
}

const BASE_PARAMS = {
  paymentAmountInInvoiceCurrency: 1250,
  paymentDate: '2026-07-12',
  accountingMethod: 'accrual',
  entityType: 'aktiebolag' as const,
}

describe('settleInvoicePayment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue({ id: 'je-1' } as never)
    vi.mocked(createInvoiceCashEntry).mockResolvedValue({ id: 'je-2' } as never)
  })

  it('books via the payment entry and forwards the settlement account', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'inv-1' }] }) // CAS update matched

    const invoice = payableInvoice({ journal_entry_id: 'je-orig' } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice, settlementAccountNumber: '1686' },
    )

    expect(result).toMatchObject({ ok: true, newStatus: 'paid', journalEntryId: 'je-1' })
    expect(vi.mocked(createInvoicePaymentJournalEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      invoice,
      '2026-07-12',
      undefined,
      'Kund AB',
      undefined,
      '1686',
    )
  })

  it('uses the cash entry for unbooked kontantmetoden invoices', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'inv-1' }] })

    const invoice = payableInvoice({ journal_entry_id: null } as Partial<Invoice>)
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice, accountingMethod: 'cash', settlementAccountNumber: '1686' },
    )

    expect(result.ok).toBe(true)
    expect(vi.mocked(createInvoiceCashEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      invoice,
      '2026-07-12',
      'aktiebolag',
      'Kund AB',
      '1686',
    )
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
  })

  it('rejects overpayment before creating any journal entry', async () => {
    const { supabase } = createQueuedMockSupabase()
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice(), paymentAmountInInvoiceCurrency: 9999 },
    )
    expect(result).toMatchObject({ ok: false, code: 'MATCH_AMOUNT_EXCEEDS_REMAINING' })
    expect(vi.mocked(createInvoicePaymentJournalEntry)).not.toHaveBeenCalled()
  })

  it('fails closed when no journal entry is produced', async () => {
    vi.mocked(createInvoicePaymentJournalEntry).mockResolvedValue(null)
    const { supabase } = createQueuedMockSupabase()
    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice() },
    )
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_BOOK_FAILED' })
  })

  it('cancels the orphaned voucher when the CAS update loses the race', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // CAS update matched nothing (concurrent settle)

    const result = await settleInvoicePayment(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      { ...BASE_PARAMS, invoice: payableInvoice() },
    )

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_PAID_RACE' })
    expect(vi.mocked(cancelOrphanedPaymentEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  it('emits invoice.paid with the settled state', async () => {
    const handler = vi.fn()
    eventBus.on('invoice.paid', handler)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'inv-1' }] })

    await settleInvoicePayment(supabase as unknown as SupabaseClient, 'company-1', 'user-1', {
      ...BASE_PARAMS,
      invoice: payableInvoice(),
    })

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 'company-1',
        paymentAmount: 1250,
        invoice: expect.objectContaining({ id: 'inv-1', status: 'paid' }),
      }),
    )
  })
})
