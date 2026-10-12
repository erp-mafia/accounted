/**
 * gnubok_categorize_transaction carries the suggestion an agent booked from
 * (proposal_id) into the staged params, where the approval executor hands it
 * to suggestion_log. It is recorded only and never changes the booking.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'

// The booking service's chart pre-validation and period-lock pre-check have
// their own tests; complete and open here.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { tools } from '../server'

const categorizeTransaction = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

beforeEach(() => {
  vi.clearAllMocks()
})

function stage(args: Record<string, unknown>) {
  const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
  const tx = makeTransaction({ id: 'tx-1', amount: -500, cash_account_id: 'cash-1' })
  enqueue({ data: tx, error: null })
  enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
  enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null })
  enqueue({ data: null, error: null })
  enqueue({ data: null, error: null })
  enqueue({ data: { id: 'op-1' }, error: null })
  return {
    run: () =>
      categorizeTransaction.execute(
        { transaction_id: 'tx-1', category: 'expense_office', allow_duplicate: true, ...args },
        'company-1',
        'user-1',
        supabase as never,
      ),
    stagedParams: () => {
      const insert = findCalls('pending_operations', 'insert')[0]?.[0] as { params?: Record<string, unknown> } | undefined
      return insert?.params
    },
  }
}

describe('gnubok_categorize_transaction: proposal_id', () => {
  it('declares proposal_id as an optional string', () => {
    const schema = categorizeTransaction.inputSchema as {
      properties: Record<string, { type: string }>
      required: string[]
    }
    expect(schema.properties.proposal_id.type).toBe('string')
    expect(schema.required).not.toContain('proposal_id')
  })

  it('stages the proposal id with the operation', async () => {
    const s = stage({ proposal_id: 'assistant:tx-1' })
    await s.run()
    expect(s.stagedParams()).toMatchObject({ proposal_id: 'assistant:tx-1' })
  })

  it('stages no proposal id when the agent chose the account itself', async () => {
    const s = stage({})
    await s.run()
    expect(s.stagedParams()).not.toHaveProperty('proposal_id')
  })
})
