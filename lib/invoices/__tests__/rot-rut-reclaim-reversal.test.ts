import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { syncRotRutReclaimAfterReversal } from '../rot-rut-reclaim-reversal'

const { supabase: mockSupabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INVOICE_A = '11111111-1111-4111-8111-111111111111'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('syncRotRutReclaimAfterReversal', () => {
  it('does nothing when the reversed voucher is not a reclaim of any begäran', async () => {
    enqueue({ data: null })
    await syncRotRutReclaimAfterReversal(supabase, 'company-1', 'je-x')
    expect(findCalls('invoices', 'update')).toHaveLength(0)
  })

  it('closes the reopened invoice again and frees the begäran', async () => {
    // 25 000 invoice, deduction 7 500, customer paid 17 500; 2 500 was
    // reclaimed and is still open when the reclaim voucher is reversed.
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({ data: [{ id: 'i1', invoice_id: INVOICE_A, reclaimed_amount: 2500 }] })
    enqueue({
      data: {
        id: INVOICE_A,
        status: 'partially_paid',
        total: 25000,
        paid_amount: 17500,
        due_date: '2099-12-31',
        deduction_total: 7500,
        deduction_reclaimed_total: 2500,
      },
    })
    enqueue({ data: null }) // invoice update
    enqueue({ data: null }) // item reset
    enqueue({ data: null }) // request reset

    await syncRotRutReclaimAfterReversal(supabase, 'company-1', 'je-reclaim')

    expect(findCall('invoices', 'update')?.[0]).toEqual({
      deduction_reclaimed_total: 0,
      remaining_amount: 0,
      status: 'paid',
    })
    expect(findCall('rot_rut_payout_request_items', 'update')?.[0]).toEqual({ reclaimed_amount: null })
    expect(findCall('rot_rut_payout_requests', 'update')?.[0]).toEqual({
      reclaim_journal_entry_id: null,
      reclaimed_at: null,
    })
  })

  it('leaves a never-paid customer share open as sent', async () => {
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({ data: [{ id: 'i1', invoice_id: INVOICE_A, reclaimed_amount: 7500 }] })
    enqueue({
      data: {
        id: INVOICE_A,
        status: 'sent',
        total: 25000,
        paid_amount: 0,
        due_date: '2099-12-31',
        deduction_total: 7500,
        deduction_reclaimed_total: 7500,
      },
    })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: null })

    await syncRotRutReclaimAfterReversal(supabase, 'company-1', 'je-reclaim')

    expect(findCall('invoices', 'update')?.[0]).toEqual({
      deduction_reclaimed_total: 0,
      remaining_amount: 17500,
      status: 'sent',
    })
  })
})
