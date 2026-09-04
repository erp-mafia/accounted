import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

import {
  appliedPaymentAmount,
  recordInvoicePaymentRow,
  removeInvoicePaymentRow,
} from '@/lib/invoices/invoice-payment-row'

describe('appliedPaymentAmount', () => {
  it('is the advance of paid_amount, not the cash received (3740 residual)', () => {
    // Remaining 999.60 settled by a 1 000.00 bank line: planInvoicePayment
    // advances paid_amount to 999.60 and 3740 carries the 0.40 (#2250).
    expect(appliedPaymentAmount({ paid_amount: 0 }, 999.6)).toBe(999.6)
  })

  it('subtracts the prior paid_amount on a final partial, rounded to the öre', () => {
    expect(appliedPaymentAmount({ paid_amount: 1000 }, 1999.6)).toBe(999.6)
  })

  it('treats a missing or null prior paid_amount as zero', () => {
    expect(appliedPaymentAmount({ paid_amount: null }, 12500)).toBe(12500)
    expect(appliedPaymentAmount({}, 12500)).toBe(12500)
  })
})

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
