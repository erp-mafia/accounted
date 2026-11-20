import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { logError } = vi.hoisted(() => ({ logError: vi.fn() }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ error: logError, warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}))

import { recordSupplierInvoicePaymentRow, removeSupplierInvoicePaymentRow } from '../supplier-invoice-payment-row'

const params = {
  userId: 'user-1',
  companyId: 'company-1',
  invoice: { id: 'si-1', currency: 'USD', paid_amount: 100 },
  paymentDate: '2026-09-15',
  newPaidAmount: 137.5,
  journalEntryId: 'je-1',
  linkBasis: { basis: 'user_created' as const },
}

describe('recordSupplierInvoicePaymentRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('stores the debt settled in the invoice currency, and why the link exists', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'pay-1' } })

    const result = await recordSupplierInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...params,
      transactionId: 'tx-1',
      exchangeRateDifference: -3.45,
      notes: 'Delbetalning',
    })

    expect(result).toEqual({ ok: true, id: 'pay-1' })
    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toEqual({
      user_id: 'user-1',
      company_id: 'company-1',
      supplier_invoice_id: 'si-1',
      payment_date: '2026-09-15',
      amount: 37.5,
      currency: 'USD',
      exchange_rate_difference: -3.45,
      journal_entry_id: 'je-1',
      transaction_id: 'tx-1',
      notes: 'Delbetalning',
      link_basis: 'user_created',
      link_evidence: null,
    })
  })

  it('defaults what a manual row has none of', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'pay-1' } })

    await recordSupplierInvoicePaymentRow(supabase as unknown as SupabaseClient, {
      ...params,
      invoice: { id: 'si-1', paid_amount: null },
    })

    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({
      amount: 137.5,
      currency: 'SEK',
      exchange_rate_difference: 0,
      transaction_id: null,
      notes: null,
    })
  })

  it('hands the SQLSTATE back: 23505 means this row already pays this invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'duplicate key', code: '23505' } })

    expect(await recordSupplierInvoicePaymentRow(supabase as unknown as SupabaseClient, params)).toEqual({
      ok: false,
      error: 'duplicate key',
      code: '23505',
    })
  })
})

describe('removeSupplierInvoicePaymentRow', () => {
  beforeEach(() => vi.clearAllMocks())

  it('deletes the row from the supplier table, in the company', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null })

    expect(await removeSupplierInvoicePaymentRow(supabase as unknown as SupabaseClient, 'company-1', 'pay-1')).toBe(true)
    expect(findCalls('supplier_invoice_payments', 'delete')).toHaveLength(1)
    expect(findCalls('supplier_invoice_payments', 'eq')).toEqual([
      ['id', 'pay-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('logs a failed rollback and never throws', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'permission denied' } })

    expect(await removeSupplierInvoicePaymentRow(supabase as unknown as SupabaseClient, 'company-1', 'pay-1')).toBe(false)
    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('stranded'),
      { message: 'permission denied' },
      { companyId: 'company-1', invoicePaymentId: 'pay-1', table: 'supplier_invoice_payments' },
    )
  })
})
