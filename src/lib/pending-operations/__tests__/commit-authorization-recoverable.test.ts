/**
 * Authorization refusals must not consume a pending operation.
 *
 * Feedback seq 261545: an API-key approve of a bulk_book_transactions op hit
 * BULK_BOOK_UNAUTHORIZED (the RPC saw auth.uid() = NULL on the service
 * client), and the dispatcher landed the op as 'rejected'. It vanished from
 * the /pending queue with nothing booked, and the user believed it had been
 * approved. A 401/403 happens before any side-effect and says nothing about
 * the op's content, so the claim is released back to 'pending' and the
 * result says so explicitly (operation_status) instead of leaving agents to
 * infer consumption from status 'failed'.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

import { commitPendingOperation } from '../commit'

// suggestion_log is recorded around every booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
// The duplicate guard and the underlag propagation have their own tests.
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: vi.fn(async () => null),
}))
vi.mock('@/lib/transactions/inbox-underlag', () => ({
  propagateUnderlagForBookedTransaction: vi.fn(async () => undefined),
}))

const TXS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]
const TX_ROWS = TXS.map((id) => ({ id, amount: 100, currency: 'SEK', description: 'Swish', date: '2026-07-22', journal_entry_id: null }))
const LINES = [
  { account_number: '1930', debit_amount: 300, credit_amount: 0, currency: 'SEK' },
  { account_number: '3001', debit_amount: 0, credit_amount: 300, currency: 'SEK' },
]

vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

function makeBulkBookOp(): PendingOperation {
  return {
    id: 'op-bulk-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'bulk_book_transactions',
    status: 'pending',
    title: 'Samlingsverifikation: 3 transaktioner 2026-07-22',
    params: {
      tx_ids: TXS,
      existing_journal_entry_id: null,
      new_entry: { description: 'Dagskassa', lines: LINES },
    },
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'deepCFO',
    risk_level: 'medium',
    created_at: '2026-08-24T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-24T00:00:00Z',
  } as PendingOperation
}

describe('commitPendingOperation: authorization refusal is recoverable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
  })

  it('releases the claim back to pending on BULK_BOOK_UNAUTHORIZED and reports operation_status', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-1' }, error: null }, // atomic claim pending -> committing
      { data: TX_ROWS, error: null }, // transactions
      { data: [{ account_number: '1930' }, { account_number: '3001' }], error: null }, // chart allowlist
      { data: [], error: null }, // account_dimension_rules
      { data: { ok: false, code: 'BULK_BOOK_UNAUTHORIZED' }, error: null }, // RPC refusal
      { data: null, error: null }, // release claim back to pending
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeBulkBookOp(),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(403)
    expect(result.code).toBe('BULK_BOOK_UNAUTHORIZED')
    expect(result.operation_status).toBe('pending')

    const updates = findCalls('pending_operations', 'update')
    expect(updates).toContainEqual([{ status: 'committing' }])
    expect(updates).toContainEqual([{ status: 'pending' }])
    expect(updates.some((args) => (args[0] as { status?: string }).status === 'rejected')).toBe(false)
  })

  it('passes the approving user as p_user_id so the service client is attributed', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-1' }, error: null },
      { data: TX_ROWS, error: null }, // transactions
      { data: [{ account_number: '1930' }, { account_number: '3001' }], error: null }, // chart allowlist
      { data: [], error: null }, // account_dimension_rules
      { data: { ok: true, journal_entry_id: 'je-1', mode: 'create_new', linked_tx_count: 3 }, error: null },
      { data: { id: 'je-1', company_id: 'company-1', status: 'posted', lines: [] }, error: null }, // engine door reload
      { data: [], error: null }, // transaction.reconciled: the booked rows re-read
      { data: null, error: null }, // finalize committed
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeBulkBookOp(),
    )

    expect(result.status).toBe('committed')
    expect(result.operation_status).toBe('committed')
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
    expect(supabase.rpc).toHaveBeenCalledWith(
      'bulk_book_transactions',
      expect.objectContaining({ p_user_id: 'user-1', p_company_id: 'company-1' }),
    )
  })

  it('still consumes the op as rejected on a genuine input error (400)', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'op-bulk-1' }, error: null },
      { data: TX_ROWS, error: null }, // transactions
      { data: [{ account_number: '1930' }, { account_number: '3001' }], error: null }, // chart allowlist
      { data: [], error: null }, // account_dimension_rules
      { data: { ok: false, code: 'BULK_BOOK_INVALID_PAYLOAD' }, error: null },
      { data: null, error: null }, // rejected update
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makeBulkBookOp(),
    )

    expect(result.status).toBe('failed')
    expect(result.operation_status).toBe('rejected')
    const updates = findCalls('pending_operations', 'update')
    expect(updates.some((args) => (args[0] as { status?: string }).status === 'rejected')).toBe(true)
  })
})
