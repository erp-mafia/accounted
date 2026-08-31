/**
 * The approval-authority ceiling inside commitPendingOperation.
 *
 * unattended-limit.test.ts covers the predicate. This file covers the thing
 * that actually matters at runtime: WHERE the check sits. It must run before
 * the atomic claim, so a refused commit leaves the operation 'pending' and a
 * human can still approve the same staged verifikat in the app. Behind the
 * claim, the refusal would be caught by the generic handler, marked terminal
 * 'rejected', and the staged work would be gone.
 *
 * Each test therefore uses createQueuedMockSupabase with NOTHING enqueued: if
 * the check ever moves below the claim, the claim runs against an empty queue
 * and the assertions on code/operation_status fail rather than passing
 * vacuously.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/entitlements/has-capability', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/entitlements/has-capability')>()
  return { ...actual, hasCapability: vi.fn().mockResolvedValue(true) }
})

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_voucher',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: { total_debit: 50000 },
    result_data: null,
    actor_type: 'api_key',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-08-01T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-08-01T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

const apiKeyActor = { type: 'api_key' as const, label: 'Bookkeeping agent' }

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: unattended commit limit', () => {
  it('refuses a 50 000 kr voucher on a key capped at 10 000, leaving the op pending', async () => {
    const { supabase } = createQueuedMockSupabase()

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({}),
      { actor: { ...apiKeyActor, unattendedCommitLimit: 10000 } },
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(403)
    expect(result.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
    // The load-bearing assertion. 'pending' is what tells the agent, and the
    // app, that the staged verifikat survived and can still be approved.
    expect(result.operation_status).toBe('pending')
    expect(result.unattended_limit).toEqual({ attempted: 50000, limit: 10000 })
    // Swedish user-facing copy, sourced from the structured-error registry.
    expect(result.error).toContain('godkännande')
  })

  it('does not fire for a human approving the same operation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null }) // claim finds no row → 409, proving we got past the ceiling

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({}),
      { actor: { type: 'user', label: 'Jakob' } },
    )

    expect(result.code).not.toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
  })

  it('does not fire when the key has no ceiling', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({}),
      { actor: { ...apiKeyActor, unattendedCommitLimit: null } },
    )

    expect(result.code).not.toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
  })

  it('does not fire with no actor at all, the cookie-session path', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({}),
    )

    expect(result.code).not.toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
  })

  it('lets an amount at the ceiling through', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp({ preview_data: { total_debit: 10000 } }),
      { actor: { ...apiKeyActor, unattendedCommitLimit: 10000 } },
    )

    expect(result.code).not.toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
  })

  it('lets a genuinely unpriceable operation type through rather than blocking it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      // pair_count is a count, not kronor. Nothing here can be compared to a
      // ceiling, so the op goes through.
      makePendingOp({
        operation_type: 'reconciliation_match',
        preview_data: { pair_count: 9 },
      }),
      { actor: { ...apiKeyActor, unattendedCommitLimit: 100 } },
    )

    expect(result.code).not.toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
  })

  it('blocks the settlement and batch paths that used to fail open', async () => {
    for (const [operation_type, preview_data] of [
      ['link_transaction_journal_entry', { transaction_amount: 250000 }],
      ['bulk_book_transactions', { tx_sum: 250000 }],
      ['link_supplier_invoice_voucher', { payment_amount: 250000 }],
      ['match_batch_allocate', { total_allocated: 250000 }],
      ['mark_invoice_paid', { total: 250000 }],
    ] as const) {
      const { supabase } = createQueuedMockSupabase()
      const result = await commitPendingOperation(
        supabase as never,
        'user-1',
        'company-1',
        makePendingOp({ operation_type, preview_data }),
        { actor: { ...apiKeyActor, unattendedCommitLimit: 10000 } },
      )
      expect(result.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
      expect(result.operation_status).toBe('pending')
    }
  })

  it('also covers categorize_transaction and supplier invoices from the inbox', async () => {
    for (const [operation_type, preview_data] of [
      ['categorize_transaction', { amount: -9000 }],
      ['create_supplier_invoice_from_inbox', { total: 9000 }],
    ] as const) {
      const { supabase } = createQueuedMockSupabase()
      const result = await commitPendingOperation(
        supabase as never,
        'user-1',
        'company-1',
        makePendingOp({ operation_type, preview_data }),
        { actor: { ...apiKeyActor, unattendedCommitLimit: 500 } },
      )
      expect(result.code).toBe('UNATTENDED_COMMIT_LIMIT_EXCEEDED')
      expect(result.operation_status).toBe('pending')
    }
  })
})
