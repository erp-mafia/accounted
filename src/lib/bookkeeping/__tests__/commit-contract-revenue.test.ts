/**
 * commitContractRevenue: the engine door to commit_contract_revenue, which
 * posts the pågående-arbeten verifikat (K3 kapitel 23) and records what it
 * was computed from in one transaction. A refusal (not a K3 year, or a
 * register that changed since the adjustment was computed) leaves the draft
 * cancelled and posts nothing; a posted verifikat is announced with
 * journal_entry.committed like every other.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const emit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({
  eventBus: { emit: (...args: unknown[]) => emit(...args) },
}))

const { commitContractRevenue } = await import('../engine')
const { BookkeepingDatabaseError, ContractRevenueRefusedError } = await import('../errors')

const POSTED = {
  id: 'draft-1',
  company_id: 'co',
  status: 'posted',
  voucher_series: 'A',
  voucher_number: 41,
  lines: [
    { account_number: '1620', debit_amount: 200_000, credit_amount: 0 },
    { account_number: '3095', debit_amount: 0, credit_amount: 200_000 },
  ],
}

const BOOKING = {
  method: 'successiv' as const,
  accounts: { revenueAdjustment: '3095', accruedRevenue: '1620' },
  contracts: [{ id: 'c1', name: 'Tak' }],
  positions: [{ id: 'c1', netto: 200_000 }],
  targets: { '1620': 200_000 },
}

function makeSupabase(rpcError: { code?: string; message: string } | null) {
  const mock = createTableMockSupabase({
    'rpc:commit_contract_revenue': { data: rpcError ? null : [{ voucher_number: 41 }], error: rpcError },
    journal_entries: { data: POSTED },
  })
  return {
    supabase: mock.supabase as never,
    rpc: mock.supabase.rpc,
    updates: () => mock.payloads('journal_entries', 'update'),
  }
}

const draft = { id: 'draft-1', fiscal_period_id: 'fp-2026' }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('commitContractRevenue', () => {
  it('commits the draft with the booking in one RPC and announces the verifikat', async () => {
    const { supabase, rpc, updates } = makeSupabase(null)
    const { entry } = await commitContractRevenue(supabase, 'co', 'user-1', draft, BOOKING)
    expect(rpc).toHaveBeenCalledWith('commit_contract_revenue', {
      p_company_id: 'co',
      p_entry_id: 'draft-1',
      p_fiscal_period_id: 'fp-2026',
      p_booking: BOOKING,
      p_actor_type: null,
      p_actor_label: null,
    })
    expect(entry).toMatchObject({ id: 'draft-1', voucher_number: 41 })
    expect(updates()).toEqual([])
    expect(emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'journal_entry.committed' }))
  })

  it.each([
    ['CONTRACT_REVENUE_NOT_K3', 'not_k3'],
    ['CONTRACT_REVENUE_STALE', 'stale'],
    ['CONTRACT_REVENUE_LATER_YEAR_BOOKED', 'later_year'],
  ] as const)('answers %s as a refusal, cancels the draft and announces nothing', async (message, reason) => {
    const { supabase, updates } = makeSupabase({ code: 'PT409', message })
    const error = await commitContractRevenue(supabase, 'co', 'user-1', draft, BOOKING).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ContractRevenueRefusedError)
    expect(error).toMatchObject({ reason })
    expect(updates()).toEqual([{ status: 'cancelled' }])
    expect(emit).not.toHaveBeenCalled()
  })

  it('answers any other failure as a database error, with the draft cancelled', async () => {
    const { supabase, updates } = makeSupabase({ code: '23514', message: 'Cannot post contract revenue in a locked or closed fiscal period' })
    await expect(commitContractRevenue(supabase, 'co', 'user-1', draft, BOOKING)).rejects.toBeInstanceOf(BookkeepingDatabaseError)
    expect(updates()).toEqual([{ status: 'cancelled' }])
    expect(emit).not.toHaveBeenCalled()
  })
})
