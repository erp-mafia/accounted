import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AP_DEBIT_SIDE, resolveSupplierSettlementSide } from '../supplier-settlement-side'
import { createQueuedMockSupabase } from '@/tests/helpers'

describe('resolveSupplierSettlementSide', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('asks the database function, by invoice id, and returns what it says', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { settlement_side: 'bank_credit', account_prefix: '19', entry_side: 'credit' } })

    const side = await resolveSupplierSettlementSide(supabase as never, 'company-1', 'si-1')

    expect(side).toEqual({ side: 'bank_credit', accountPrefix: '19', entrySide: 'credit' })
    expect(supabase.rpc).toHaveBeenCalledWith('supplier_invoice_settlement_side', {
      p_supplier_invoice_id: 'si-1',
      p_company_id: 'company-1',
    })
  })

  // Falling back to the 244x debit is the behaviour every invoice had before the
  // function existed: a deploy that reaches the app before the migration, or a
  // transient read failure, must never widen the search to 19xx on a guess.
  it.each([
    ['the call fails', { data: null, error: { message: 'function does not exist' } }],
    ['the invoice is not visible (no row)', { data: null }],
    ['the answer is not one of the two sides', { data: { settlement_side: 'x', account_prefix: '30', entry_side: 'credit' } }],
  ])('falls back to the 244x debit when %s', async (_label, response) => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue(response)
    const side = await resolveSupplierSettlementSide(supabase as never, 'company-1', 'si-1')
    expect(side).toEqual(AP_DEBIT_SIDE)
  })
})
