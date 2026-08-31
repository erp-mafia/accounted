/**
 * Executor tests for the staged ignore_transaction operation (issue #1661):
 * commitIgnoreTransaction is private to commit.ts and reached through
 * commitPendingOperation (same pattern as account-and-note-executors.test.ts).
 * Staging-side coverage lives in
 * extensions/general/mcp-server/__tests__/ignore-transaction.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { commitPendingOperation } from '../commit'

const TX_ID = '00000000-0000-4000-8000-0000000000aa'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'ignore_transaction',
    status: 'pending',
    title: 'test',
    params: { transaction_id: TX_ID, ignored: true },
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'low',
    created_at: '2026-08-29T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-29T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

function enqueueNoAnchors(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: [] }) // transaction_voucher_links
  enqueue({ data: [] }) // invoice_payments
  enqueue({ data: [] }) // supplier_invoice_payments
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: ignore_transaction', () => {
  it('happy path: flips is_ignored on an unbooked row and returns committed', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_ignored: false } }) // core fetch
    enqueueNoAnchors(enqueue)
    enqueue({ data: null }) // update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ transaction_id: TX_ID, is_ignored: true, changed: true })
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: true }]])
  })

  it('is idempotent: an already-ignored row commits with changed=false and no write', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_ignored: true } }) // core fetch
    enqueueNoAnchors(enqueue)
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ is_ignored: true, changed: false })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a row that got booked between staging and approval (TX_IGNORE_ALREADY_BOOKED)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: 'je-1', is_ignored: false } }) // core fetch: booked now
    enqueue({ data: null }) // dispatcher reject/finalize update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(result.error).toContain('redan bokförd')
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a junction-anchored row (journal_entry_id NULL, voucher link present)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_ignored: false } })
    enqueue({ data: [{ transaction_id: TX_ID }] }) // transaction_voucher_links
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restore (ignored: false) clears the flag', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_ignored: true } }) // core fetch
    enqueue({ data: null }) // update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ params: { transaction_id: TX_ID, ignored: false } }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ is_ignored: false, changed: true })
    expect(findCalls('transactions', 'update')).toEqual([[{ is_ignored: false }]])
  })

  it('rejects tampered params (non-UUID transaction_id) at the commit boundary', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ params: { transaction_id: 'not-a-uuid', ignored: true } }),
    )

    expect(result.status).not.toBe('committed')
    expect(result.error).toMatch(/transaction_id/)
    expect(findCalls('transactions', 'select')).toEqual([])
  })
})
