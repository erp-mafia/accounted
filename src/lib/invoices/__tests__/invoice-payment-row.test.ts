import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

import { recordInvoicePaymentRow, removeInvoicePaymentRow } from '@/lib/invoices/invoice-payment-row'

describe('recordInvoicePaymentRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores the applied amount, not the cash received', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-1' } })

    // Öresavrundning: 1 235 kr received against a 1 234.75 remaining; the
    // 0.25 sits on 3740 and is not part of the receivable.
    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1', currency: 'SEK', exchange_rate: null, paid_amount: 500 },
      paymentDate: '2026-08-28',
      newPaidAmount: 1734.75,
      journalEntryId: 'je-1',
    })

    expect(result).toEqual({ ok: true, id: 'ip-1' })
    expect(findCalls('invoice_payments', 'insert')[0][0]).toEqual({
      user_id: 'user-1',
      company_id: 'company-1',
      invoice_id: 'inv-1',
      payment_date: '2026-08-28',
      amount: 1234.75,
      currency: 'SEK',
      exchange_rate: null,
      journal_entry_id: 'je-1',
      transaction_id: null,
      notes: null,
    })
  })

  it('subtracts the prior paid_amount on a final partial, rounded to the öre (#2250)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-2' } })

    // Remaining 999.60 after a 1 000 partial, settled by a 1 000.00 bank line:
    // planInvoicePayment advances paid_amount to 1 999.60 and 3740 carries the
    // 0.40. 1999.6 - 1000 is not exact in IEEE 754; roundOre makes it 999.60.
    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1', currency: 'SEK', exchange_rate: null, paid_amount: 1000 },
      paymentDate: '2026-08-28',
      newPaidAmount: 1999.6,
      journalEntryId: 'je-1',
    })

    expect(findCalls('invoice_payments', 'insert')[0][0]).toMatchObject({ amount: 999.6 })
  })

  it('treats a missing prior paid_amount as zero and defaults currency to SEK', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-3' } })

    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1' },
      paymentDate: '2026-08-28',
      newPaidAmount: 12500,
      journalEntryId: 'je-1',
    })

    expect(findCalls('invoice_payments', 'insert')[0][0]).toMatchObject({
      amount: 12500,
      currency: 'SEK',
      exchange_rate: null,
      transaction_id: null,
      notes: null,
    })
  })

  it('bank match: carries the transaction, the rate actually used and the note', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-4' } })

    // 1 000 SEK bank line on a 140 USD invoice booked at 9.30, spot 10.45 on
    // the payment date: the row records the spot rate (ML 8 kap 21-23 §), not
    // the booking rate, and the öre-rounded applied amount.
    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1', currency: 'USD', exchange_rate: 9.3, paid_amount: 0 },
      paymentDate: '2026-05-30',
      newPaidAmount: 95.69,
      journalEntryId: 'je-fx',
      transactionId: 'tx-1',
      exchangeRate: 10.45,
      notes: 'Manuell kurs 10,45',
    })

    expect(result).toEqual({ ok: true, id: 'ip-4' })
    expect(findCalls('invoice_payments', 'insert')[0][0]).toEqual({
      user_id: 'user-1',
      company_id: 'company-1',
      invoice_id: 'inv-1',
      payment_date: '2026-05-30',
      amount: 95.69,
      currency: 'USD',
      exchange_rate: 10.45,
      journal_entry_id: 'je-fx',
      transaction_id: 'tx-1',
      notes: 'Manuell kurs 10,45',
    })
  })

  it('an explicit null exchangeRate is stored as null, not replaced by the invoice rate', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'ip-5' } })

    // The link-to-existing-voucher flow records no rate for a SEK bank line
    // even when the invoice carries a booking rate.
    await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1', currency: 'SEK', exchange_rate: 9.3, paid_amount: 0 },
      paymentDate: '2026-08-28',
      newPaidAmount: 100,
      journalEntryId: 'je-1',
      transactionId: 'tx-1',
      exchangeRate: null,
    })

    expect(findCalls('invoice_payments', 'insert')[0][0]).toMatchObject({
      exchange_rate: null,
      transaction_id: 'tx-1',
    })
  })

  it('surfaces the Postgres SQLSTATE so a caller can map a unique violation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'duplicate key value', code: '23505' } })
    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1' },
      paymentDate: '2026-08-28',
      newPaidAmount: 100,
      journalEntryId: 'je-1',
    })
    expect(result).toEqual({ ok: false, error: 'duplicate key value', code: '23505' })
  })

  it('reports an insert failure instead of throwing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'rls' } })
    const result = await recordInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      userId: 'user-1',
      companyId: 'company-1',
      invoice: { id: 'inv-1' },
      paymentDate: '2026-08-28',
      newPaidAmount: 100,
      journalEntryId: 'je-1',
    })
    expect(result).toEqual({ ok: false, error: 'rls' })
  })
})

describe('removeInvoicePaymentRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes by id and company and reports success', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      removeInvoicePaymentRow(supabase as unknown as SupabaseClient, 'company-1', 'ip-1'),
    ).resolves.toBe(true)
    expect(findCalls('invoice_payments', 'delete')).toHaveLength(1)
    expect(findCalls('invoice_payments', 'eq')).toEqual([
      ['id', 'ip-1'],
      ['company_id', 'company-1'],
    ])
    expect(logError).not.toHaveBeenCalled()
  })

  it('logs a failed rollback at error level with the row id, and never throws', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'permission denied' } })
    await expect(
      removeInvoicePaymentRow(supabase as unknown as SupabaseClient, 'company-1', 'ip-1'),
    ).resolves.toBe(false)
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('stranded'),
      { message: 'permission denied' },
      { companyId: 'company-1', invoicePaymentId: 'ip-1' },
    )
  })

  it('is a no-op without a row id', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    await expect(
      removeInvoicePaymentRow(supabase as unknown as SupabaseClient, 'company-1', null),
    ).resolves.toBe(true)
    expect(findCalls('invoice_payments', 'delete')).toHaveLength(0)
  })
})
