import { describe, it, expect, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  classifyPaymentHistoryGap,
  fetchInvoicePaymentVouchers,
  type PaymentVoucherRef,
} from '../payment-history-gap'
import { PAYMENT_VOUCHER_SOURCE_TYPES } from '../backfill-invoice-payment-rows'

const voucher: PaymentVoucherRef = {
  id: 'je-1',
  entry_date: '2025-03-12',
  voucher_series: 'A',
  voucher_number: 217,
}

describe('classifyPaymentHistoryGap', () => {
  it('is none for an unsettled invoice, whatever the rows say', () => {
    for (const status of ['draft', 'sent', 'overdue', 'cancelled', 'credited']) {
      expect(
        classifyPaymentHistoryGap({ status, paymentRows: 0, paymentVouchers: [] }),
      ).toEqual({ kind: 'none' })
      expect(
        classifyPaymentHistoryGap({ status, paymentRows: null, paymentVouchers: null }),
      ).toEqual({ kind: 'none' })
    }
  })

  it('is none when payment rows exist: the list is the truth', () => {
    expect(
      classifyPaymentHistoryGap({
        status: 'paid',
        paid_at: '2025-03-12T12:00:00Z',
        paymentRows: 1,
        paymentVouchers: [voucher],
      }),
    ).toEqual({ kind: 'none' })
    // Rows exist, so the voucher lookup's outcome is irrelevant.
    expect(
      classifyPaymentHistoryGap({ status: 'partially_paid', paymentRows: 2, paymentVouchers: null }),
    ).toEqual({ kind: 'none' })
  })

  it('reports a migrated invoice paid before Accounted had it (#2213)', () => {
    expect(
      classifyPaymentHistoryGap({
        status: 'paid',
        paid_at: '2025-03-12T12:00:00Z',
        paymentRows: 0,
        paymentVouchers: [],
      }),
    ).toEqual({ kind: 'settled_before_accounted', paid_at: '2025-03-12T12:00:00Z', full: true })
  })

  it('keeps the partial flag for a migrated partly paid invoice and tolerates a missing date', () => {
    expect(
      classifyPaymentHistoryGap({ status: 'partially_paid', paymentRows: 0, paymentVouchers: [] }),
    ).toEqual({ kind: 'settled_before_accounted', paid_at: null, full: false })
    expect(
      classifyPaymentHistoryGap({ status: 'paid', paid_at: null, paymentRows: 0, paymentVouchers: [] }),
    ).toEqual({ kind: 'settled_before_accounted', paid_at: null, full: true })
  })

  it('shows the vouchers when the invoice was settled here but the row is missing (#2019 leftovers)', () => {
    const second = { ...voucher, id: 'je-2', entry_date: '2025-04-01', voucher_number: 260 }
    expect(
      classifyPaymentHistoryGap({
        status: 'paid',
        paid_at: '2025-04-01T12:00:00Z',
        paymentRows: 0,
        paymentVouchers: [voucher, second],
      }),
    ).toEqual({ kind: 'vouchers_without_rows', vouchers: [voucher, second] })
  })

  it('never asserts a provenance when a lookup failed', () => {
    expect(
      classifyPaymentHistoryGap({ status: 'paid', paymentRows: null, paymentVouchers: [] }),
    ).toEqual({ kind: 'unreadable' })
    expect(
      classifyPaymentHistoryGap({ status: 'paid', paymentRows: 0, paymentVouchers: null }),
    ).toEqual({ kind: 'unreadable' })
  })
})

describe('fetchInvoicePaymentVouchers', () => {
  const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient

  beforeEach(() => {
    reset()
  })

  it('looks up posted payment vouchers keyed on the invoice, oldest first', async () => {
    enqueue({ data: [voucher], error: null })

    await expect(fetchInvoicePaymentVouchers(client, 'inv-1')).resolves.toEqual([voucher])

    expect(findCall('journal_entries', 'select')).toEqual([
      'id, entry_date, voucher_series, voucher_number',
    ])
    expect(findCalls('journal_entries', 'eq')).toEqual([
      ['source_id', 'inv-1'],
      ['status', 'posted'],
    ])
    expect(findCall('journal_entries', 'in')).toEqual([
      'source_type',
      [...PAYMENT_VOUCHER_SOURCE_TYPES],
    ])
    expect(findCall('journal_entries', 'order')).toEqual(['entry_date', { ascending: true }])
  })

  it('returns an empty list when nothing is keyed on the invoice', async () => {
    enqueue({ data: [], error: null })
    await expect(fetchInvoicePaymentVouchers(client, 'inv-1')).resolves.toEqual([])
  })

  it('returns null, not an empty list, when the lookup fails', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(fetchInvoicePaymentVouchers(client, 'inv-1')).resolves.toBeNull()
  })
})
