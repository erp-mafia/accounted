import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadOpenRotRutPayoutRequests } from '../open-rot-rut-payout-requests'
import { OPEN_ROT_RUT_PAYOUT_STATUSES } from '../rot-rut-payout-matching'

/**
 * The one read of the open ROT/RUT begäran behind the transactions list's
 * match hints and the invoice picker's manual fallback. Both wrote the same
 * query and the same row mapping before; these pin what they agreed on.
 */
describe('loadOpenRotRutPayoutRequests', () => {
  const row = {
    id: 'req-1',
    name: 'Begäran 1',
    deduction_type: 'rut',
    status: 'paid',
    requested_total: '1500.00',
    decided_total: null,
    settlement_journal_entry_id: null,
    items: [
      { requested_amount: '1000.00', invoice: { invoice_number: 'F-1' } },
      { requested_amount: '500.00', invoice: [{ invoice_number: 'F-2' }] },
      { requested_amount: '0', invoice: null },
    ],
  }

  it('reads only open, unsettled requests of the company, newest first', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await loadOpenRotRutPayoutRequests(supabase as never, 'company-1')

    expect(findCall('rot_rut_payout_requests', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('rot_rut_payout_requests', 'in')).toEqual(['status', [...OPEN_ROT_RUT_PAYOUT_STATUSES]])
    expect(findCall('rot_rut_payout_requests', 'is')).toEqual(['settlement_journal_entry_id', null])
    expect(findCall('rot_rut_payout_requests', 'order')).toEqual(['created_at', { ascending: false }])
  })

  it('maps each request with the invoices it covers, whichever shape the embed takes', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row] })

    const { requests, error } = await loadOpenRotRutPayoutRequests(supabase as never, 'company-1')

    expect(error).toBeNull()
    expect(requests).toEqual([
      {
        id: 'req-1',
        name: 'Begäran 1',
        deduction_type: 'rut',
        status: 'paid',
        requested_total: '1500.00',
        decided_total: null,
        settlement_journal_entry_id: null,
        invoices: [
          { invoice_number: 'F-1', requested_amount: '1000.00' },
          { invoice_number: 'F-2', requested_amount: '500.00' },
          { invoice_number: null, requested_amount: '0' },
        ],
      },
    ])
  })

  it('answers no requests with the error on a failed read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })

    const result = await loadOpenRotRutPayoutRequests(supabase as never, 'company-1')

    expect(result).toEqual({ requests: [], error: { message: 'boom' } })
  })
})
