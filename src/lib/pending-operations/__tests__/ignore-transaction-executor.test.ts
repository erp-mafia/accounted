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

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: ignore_transaction', () => {
  it('happy path: flips is_ignored on an unbooked row and returns committed', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_booked: false, is_ignored: false } }) // core fetch
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
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_booked: false, is_ignored: true } }) // core fetch
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ is_ignored: true, changed: false })
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a row that got booked between staging and approval (TX_IGNORE_ALREADY_BOOKED)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: 'je-1', is_booked: true, is_ignored: false } }) // core fetch: booked now
    enqueue({ data: null }) // dispatcher reject/finalize update

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(result.error).toContain('redan bokförd')
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('refuses a junction-anchored row (journal_entry_id NULL, is_booked true)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_booked: true, is_ignored: false } })
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', makePendingOp({}))

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restore (ignored: false) clears the flag', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: TX_ID, journal_entry_id: null, is_booked: false, is_ignored: true } }) // core fetch
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

  it('rejects params that name both a bank transaction and a skattekonto row', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1',
      makePendingOp({ params: { transaction_id: TX_ID, skattekonto_transaction_id: SKV_ID, ignored: true } }),
    )

    expect(result.status).not.toBe('committed')
    expect(result.error).toMatch(/exactly one/)
    expect(findCalls('transactions', 'select')).toEqual([])
    expect(findCalls('skattekonto_transactions', 'select')).toEqual([])
  })
})

const SKV_ID = '00000000-0000-4000-8000-0000000000bb'

describe('commitPendingOperation: ignore_transaction on a skattekonto row (crm#1178)', () => {
  const skvOp = (ignored = true) =>
    makePendingOp({ params: { skattekonto_transaction_id: SKV_ID, ignored } })

  it('ignores an unlinked row through setItemIgnored and never touches transactions', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: SKV_ID, journal_entry_id: null, is_ignored: false } }) // row fetch
    enqueue({ data: [{ id: SKV_ID }] }) // guarded update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', skvOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ skattekonto_transaction_id: SKV_ID, is_ignored: true })
    expect(findCalls('skattekonto_transactions', 'update')).toEqual([
      [{ is_ignored: true, suggested_journal_entry_id: null, suggested_at: null }],
    ])
    expect(findCalls('transactions', 'select')).toEqual([])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restore clears the flag', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: SKV_ID, journal_entry_id: null, is_ignored: true } }) // row fetch
    enqueue({ data: [{ id: SKV_ID }] }) // update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', skvOp(false))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ skattekonto_transaction_id: SKV_ID, is_ignored: false })
    expect(findCalls('skattekonto_transactions', 'update')).toEqual([[{ is_ignored: false }]])
  })

  it('refuses a row linked between staging and approval with TX_IGNORE_ALREADY_BOOKED', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: { id: SKV_ID, journal_entry_id: 'je-1', is_ignored: false } }) // linked now
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', skvOp())

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('TX_IGNORE_ALREADY_BOOKED')
    expect(result.error).toMatch(/Koppla bort/)
    expect(findCalls('skattekonto_transactions', 'update')).toEqual([])
  })

  it('answers NOT_FOUND for a row that is not the company\'s', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // row fetch: none
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', skvOp())

    expect(result.status).not.toBe('committed')
    expect(result.code).toBe('NOT_FOUND')
    expect(findCalls('skattekonto_transactions', 'update')).toEqual([])
  })
})

describe('commitPendingOperation: ignore_transaction over pinned ids (crm#1647)', () => {
  const CASH = '00000000-0000-4000-8000-0000000000ca'
  const A = '00000000-0000-4000-8000-0000000000a1'
  const B = '00000000-0000-4000-8000-0000000000b2'
  const bulkOp = (ignored = true) =>
    makePendingOp({ params: { transaction_ids: [A, B], cash_account_id: CASH, before_date: '2026-01-01', ignored } })

  it('ignores the pinned rows that are still open and counts the rest as skipped', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: [{ id: A }] }) // re-read: B was booked since staging
    enqueue({ data: [{ id: A }] }) // update ... select
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', bulkOp())

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ is_ignored: true, changed_count: 1, skipped_count: 1 })
    expect(findCalls('open_bank_rows', 'in')).toEqual([['id', [A, B]]])
    expect(findCalls('transactions', 'update')[0]).toEqual([{ is_ignored: true }])
  })

  it('restores the pinned rows that are still ignored', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: [{ id: A }, { id: B }] }) // re-read
    enqueue({ data: [{ id: A }, { id: B }] }) // update ... select
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', bulkOp(false))

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ is_ignored: false, changed_count: 2, skipped_count: 0 })
    expect(findCalls('transactions', 'update')[0]).toEqual([{ is_ignored: false }])
  })

  it('refuses pinned ids staged without the selection they came from', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { transaction_ids: [A], ignored: true } }),
    )

    expect(result.status).not.toBe('committed')
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('open_bank_rows', 'select')).toEqual([])
  })

  it('refuses a params bag naming both one row and pinned ids', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' } }) // CAS claim
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ params: { transaction_id: TX_ID, transaction_ids: [A], cash_account_id: CASH, before_date: '2026-01-01' } }),
    )

    expect(result.status).not.toBe('committed')
    expect(findCalls('transactions', 'update')).toEqual([])
  })
})
