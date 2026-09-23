import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { syncRotRutReclaimAfterReversal } from '../rot-rut-reclaim-reversal'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient

const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INVOICE_A = '11111111-1111-4111-8111-111111111111'
const INVOICE_B = '33333333-3333-4333-8333-333333333333'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('syncRotRutReclaimAfterReversal', () => {
  it('does nothing when the reversed voucher is not a reclaim of any begäran', async () => {
    enqueue({ data: null })
    await syncRotRutReclaimAfterReversal(supabase, 'company-1', 'je-x')
    expect(mockSupabase.rpc).not.toHaveBeenCalled()
    expect(findCalls('rot_rut_payout_requests', 'update')).toHaveLength(0)
  })

  it('reverts every marked leg through the RPC, then frees the begäran', async () => {
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({
      data: [
        { id: 'i1', invoice_id: INVOICE_A, reclaimed_amount: 2500 },
        { id: 'i2', invoice_id: INVOICE_B, reclaimed_amount: null }, // never applied: skipped
      ],
    })
    enqueue({ data: { reverted: true, remaining_amount: 0, status: 'paid' } }) // revert i1
    enqueue({ data: null }) // request reset

    await syncRotRutReclaimAfterReversal(supabase, 'company-1', 'je-reclaim')

    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(mockSupabase.rpc).toHaveBeenCalledWith('revert_rot_rut_reclaim_invoice', {
      p_item_id: 'i1',
      p_invoice_id: INVOICE_A,
      p_company_id: 'company-1',
    })
    const requestUpdates = findCalls('rot_rut_payout_requests', 'update')
    expect(requestUpdates).toHaveLength(1)
    expect(requestUpdates[0][0]).toEqual({ reclaim_journal_entry_id: null, reclaimed_at: null })
  })

  it('keeps the request link when a leg fails, so a re-run can finish', async () => {
    enqueue({ data: { id: REQUEST_ID } })
    enqueue({
      data: [
        { id: 'i1', invoice_id: INVOICE_A, reclaimed_amount: 2500 },
        { id: 'i2', invoice_id: INVOICE_B, reclaimed_amount: 1000 },
      ],
    })
    enqueue({ data: null, error: { message: 'deadlock detected' } }) // revert i1 fails

    await syncRotRutReclaimAfterReversal(supabase, 'company-1', 'je-reclaim')

    expect(mockSupabase.rpc).toHaveBeenCalledTimes(1)
    expect(findCalls('rot_rut_payout_requests', 'update')).toHaveLength(0)
  })
})
