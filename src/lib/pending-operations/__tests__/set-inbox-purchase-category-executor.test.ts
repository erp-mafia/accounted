/**
 * set_inbox_purchase_category, staged by gnubok_set_inbox_purchase_category:
 * an approval runs the operation inbox-items.set-purchase-category, the same
 * service call the v1 PUT makes (the choice on the item's reading, and with
 * every_time the matched supplier's instruction, pinned to the supplier the
 * card named); a rejection writes nothing
 * but the pending operation. The approval posts no verifikat, so the decision
 * receipt writer (lib/suggestion-log/operation.ts), which runs after every
 * commit, records no suggestion_log row: like every staged operation without
 * a voucher, the pending_operations row is the record of who proposed and
 * who approved it.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

const mockAppend = vi.hoisted(() => vi.fn())
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...a: unknown[]) => mockAppend(...a),
}))

import { commitPendingOperation } from '../commit'
import { rejectPendingOperations } from '../reject'

const ITEM = '22222222-2222-4222-8222-222222222222'
const SUPPLIER = '33333333-3333-4333-8333-333333333333'
const OTHER_SUPPLIER = '44444444-4444-4444-8444-444444444444'
const READING = { supplier: { name: 'Telia Company AB' }, lineItems: [] }

function stagedOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'set_inbox_purchase_category',
    status: 'pending',
    title: 'Ändra kategori för underlag från Telia Company AB, varje gång',
    params,
    preview_data: { inbox_item_id: ITEM, purchase_category_code: params.code, supplier_name: 'Telia Company AB' },
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Claude',
    risk_level: 'low',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-10-16T08:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-16T08:00:00Z',
  }
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ITEM,
    extracted_data: READING,
    matched_supplier_id: SUPPLIER,
    created_supplier_invoice_id: null,
    updated_at: '2026-10-16T08:30:00.000Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mockAppend.mockResolvedValue('event-1')
})

describe('approving set_inbox_purchase_category', () => {
  it('stores the choice and the supplier instruction through the v1 service, and answers what the item reads', async () => {
    const { supabase, enqueue, findCall, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T09:00:00Z' } }) // CAS claim
    enqueue({ data: itemRow() }) // the item, read fresh at approval
    enqueue({ data: { id: SUPPLIER } }) // supplier instruction
    enqueue({ data: { id: ITEM } }) // the item's choice
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      stagedOp({ inbox_item_id: ITEM, code: 'expense.telecom.mobile', every_time: true, expected_supplier_id: SUPPLIER }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toEqual({
      inbox_item_id: ITEM,
      purchase_category: { code: 'expense.telecom.mobile', source: 'person', level: 'Ditt val', version: 'pc-2026-10' },
    })
    expect(findCall('suppliers', 'update')?.[0]).toEqual({ default_purchase_category: 'expense.telecom.mobile' })
    const written = (findCall('invoice_inbox_items', 'update')?.[0] as { extracted_data: Record<string, unknown> }).extracted_data
    // The stored choice says it came through an approval, not the api door.
    expect(written).toMatchObject({ ...READING, purchaseCategory: { code: 'expense.telecom.mobile', source: 'person', set_via: 'approval' } })
    // Company-scoped, and under optimistic concurrency on the row it read.
    expect(calls.filter((c) => c.table === 'invoice_inbox_items' && c.method === 'eq').map((c) => c.args)).toEqual(
      expect.arrayContaining([['company_id', 'company-1'], ['updated_at', '2026-10-16T08:30:00.000Z']]),
    )
    // No verifikat was posted, so no receipt row is written.
    expect(findCall('suggestion_log', 'insert')).toBeUndefined()
    // The claim, then the finalize.
    expect(findCalls('pending_operations', 'update').map((args) => (args[0] as { status: string }).status)).toEqual([
      'committing',
      'committed',
    ])
  })

  it('without every_time leaves the supplier alone', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T09:00:00Z' } })
    enqueue({ data: itemRow() })
    enqueue({ data: { id: ITEM } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      stagedOp({ inbox_item_id: ITEM, code: 'expense.telecom.mobile' }),
    )

    expect(result.status).toBe('committed')
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('refuses, writing nothing, when the item was matched to another supplier after staging', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T09:00:00Z' } })
    enqueue({ data: itemRow({ matched_supplier_id: OTHER_SUPPLIER }) })
    enqueue({ data: null }) // the dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      stagedOp({ inbox_item_id: ITEM, code: 'expense.telecom.mobile', every_time: true, expected_supplier_id: SUPPLIER }),
    )

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('INBOX_ITEM_SUPPLIER_CHANGED')
    expect(result.data).toEqual({ expected_supplier_id: SUPPLIER, matched_supplier_id: OTHER_SUPPLIER })
    // Neither the instruction nor the item's choice.
    expect(findCall('suppliers', 'update')).toBeUndefined()
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
  })

  it('refuses, writing nothing, when the item became a supplier invoice after staging', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T09:00:00Z' } })
    enqueue({ data: itemRow({ created_supplier_invoice_id: 'si-1' }) })
    enqueue({ data: null }) // the dispatcher's reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      stagedOp({ inbox_item_id: ITEM, code: 'expense.telecom.mobile', every_time: true }),
    )

    expect(result.status).toBe('rejected')
    expect(result.code).toBe('INBOX_ITEM_EDIT_LOCKED')
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })

  it('re-validates the staged params at the commit boundary', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1', updated_at: '2026-10-16T09:00:00Z' } })
    enqueue({ data: null })

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      stagedOp({ inbox_item_id: ITEM, code: 'not.a.code' }),
    )

    expect(result.code).toBe('VALIDATION_ERROR')
    expect(findCall('invoice_inbox_items', 'select')).toBeUndefined()
  })
})

describe('rejecting set_inbox_purchase_category', () => {
  it('writes the rejection and nothing on the item or the supplier', async () => {
    const { supabase, enqueueMany, findCall } = createQueuedMockSupabase()
    enqueueMany([
      { data: [{ id: 'op-1', status: 'pending', operation_type: 'set_inbox_purchase_category', risk_level: 'low' }] },
      { data: [{ id: 'op-1' }] },
    ])

    const result = await rejectPendingOperations(supabase as never, {
      companyId: 'company-1',
      ids: ['op-1'],
      category: 'wrong_category',
      actor: { userId: 'user-1', type: 'user' },
      channel: 'app',
    })

    expect(result).toEqual({ ok: true, outcomes: [{ id: 'op-1', outcome: 'rejected' }] })
    expect(findCall('pending_operations', 'update')?.[0]).toMatchObject({ status: 'rejected', rejection_category: 'wrong_category' })
    expect(findCall('invoice_inbox_items', 'select')).toBeUndefined()
    expect(findCall('invoice_inbox_items', 'update')).toBeUndefined()
    expect(findCall('suppliers', 'update')).toBeUndefined()
  })
})
