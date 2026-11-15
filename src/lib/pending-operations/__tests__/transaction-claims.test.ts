/**
 * One bank row, one open proposal (crm#1264): the read every staging door
 * makes before it inserts a categorize_transaction or bulk_book_transactions,
 * and the supersede write after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import {
  checkTransactionClaims,
  claimedTransactionIds,
  openTransactionClaims,
  supersedeTransactionClaims,
  transactionAlreadyStagedFailure,
} from '../transaction-claims'

vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))

const TX_1 = '11111111-1111-4111-8111-111111111111'
const TX_2 = '22222222-2222-4222-8222-222222222222'
const TX_3 = '33333333-3333-4333-8333-333333333333'

/** The agent's key that staged the open proposals below. */
const AGENT = { userId: 'user-1', actorType: 'api_key', actorId: 'key-1' }

function op(overrides: Record<string, unknown>) {
  return {
    id: 'op-1',
    user_id: 'user-1',
    actor_type: 'api_key',
    actor_id: 'key-1',
    operation_type: 'bulk_book_transactions',
    status: 'pending',
    params: { tx_ids: [TX_1], entry_description: 'Avgifter' },
    preview_data: {},
    risk_level: 'high',
    created_at: '2026-10-16T08:00:00.000Z',
    ...overrides,
  }
}

async function check(open: unknown[], operationType: string, params: Record<string, unknown>, stager = AGENT) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: open, error: null })
  const result = await checkTransactionClaims(mock.supabase as never, 'company-1', operationType, params, stager)
  return { result, ...mock }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('claimedTransactionIds', () => {
  it('reads the rows each booking type names', () => {
    expect(claimedTransactionIds('bulk_book_transactions', { tx_ids: [TX_1, TX_2] })).toEqual([TX_1, TX_2])
    expect(claimedTransactionIds('categorize_transaction', { transaction_id: TX_1 })).toEqual([TX_1])
  })

  it('names no rows for another type or a malformed params bag', () => {
    expect(claimedTransactionIds('create_voucher', { transaction_id: TX_1 })).toEqual([])
    expect(claimedTransactionIds('bulk_book_transactions', { tx_ids: 'not-a-list' })).toEqual([])
    expect(claimedTransactionIds('categorize_transaction', {})).toEqual([])
    expect(claimedTransactionIds('categorize_transaction', null)).toEqual([])
  })
})

describe('checkTransactionClaims', () => {
  it('reads nothing for an operation type that books no bank row', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    const result = await checkTransactionClaims(supabase as never, 'company-1', 'create_customer', { name: 'X' }, AGENT)
    expect(result).toEqual({ kind: 'clear' })
    expect(calls).toHaveLength(0)
  })

  it('is clear when no open operation names the rows (a rejected or expired one is not read)', async () => {
    const { result, findCalls } = await check([op({ id: 'op-other', params: { tx_ids: [TX_3] } })], 'bulk_book_transactions', {
      tx_ids: [TX_1, TX_2],
    })

    expect(result).toEqual({ kind: 'clear' })
    expect(findCalls('pending_operations', 'in')).toContainEqual(['status', ['pending', 'committing']])
    expect(findCalls('pending_operations', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('answers the same proposal again as a replay, whatever the key order and whoever staged it', async () => {
    const { result } = await check(
      [op({ actor_id: 'key-other', params: { entry_description: 'Avgifter', tx_ids: [TX_1], force: true } })],
      'bulk_book_transactions',
      // default_dimensions: undefined is dropped by JSON, as in the stored row.
      { tx_ids: [TX_1], force: true, entry_description: 'Avgifter', default_dimensions: undefined },
    )

    expect(result.kind).toBe('replay')
    if (result.kind === 'replay') expect(result.operation.id).toBe('op-1')
  })

  it("supersedes the same stager's pending proposal when the new one covers all of its rows", async () => {
    const { result } = await check([op({ params: { tx_ids: [TX_1], entry_description: 'Avgifter v1' } })], 'bulk_book_transactions', {
      tx_ids: [TX_1, TX_2],
      entry_description: 'Avgifter v2',
    })

    expect(result.kind).toBe('supersede')
    if (result.kind === 'supersede') expect(result.operations.map((o) => o.id)).toEqual(['op-1'])
  })

  it('supersedes across the two types when the cover is complete (a categorize folded into a batch)', async () => {
    const { result } = await check(
      [op({ id: 'op-cat', operation_type: 'categorize_transaction', params: { transaction_id: TX_1 } })],
      'bulk_book_transactions',
      { tx_ids: [TX_1, TX_2] },
    )

    expect(result.kind).toBe('supersede')
  })

  it("refuses another stager's proposal: a different key, the same user", async () => {
    const { result } = await check(
      [op({ params: { tx_ids: [TX_1], entry_description: 'Annat' } })],
      'bulk_book_transactions',
      { tx_ids: [TX_1] },
      { ...AGENT, actorId: 'key-2' },
    )

    expect(result).toEqual({
      kind: 'claimed',
      claims: [{ operation_id: 'op-1', operation_type: 'bulk_book_transactions', status: 'pending', created_at: '2026-10-16T08:00:00.000Z', transaction_ids: [TX_1] }],
    })
  })

  it("knows an OAuth key's own older proposal, which carries api_key from before it staged as mcp_oauth", async () => {
    const stager = { userId: 'user-1', actorType: 'mcp_oauth', actorId: 'key-1' }
    const { result } = await check([op({ params: { tx_ids: [TX_1] } })], 'bulk_book_transactions', { tx_ids: [TX_1, TX_2] }, stager)

    expect(result.kind).toBe('supersede')
  })

  it('does not take a proposal with no key for the key that stages now', async () => {
    const stager = { userId: 'user-1', actorType: 'mcp_oauth', actorId: 'key-1' }
    const { result } = await check([op({ actor_id: null })], 'categorize_transaction', { transaction_id: TX_1 }, stager)

    expect(result.kind).toBe('claimed')
  })

  it("refuses another user's proposal and a person's own in the app", async () => {
    const other = await check([op({ user_id: 'user-2' })], 'categorize_transaction', { transaction_id: TX_1 })
    expect(other.result.kind).toBe('claimed')
    const person = await check([op({ actor_type: 'user', actor_id: null })], 'categorize_transaction', { transaction_id: TX_1 })
    expect(person.result.kind).toBe('claimed')
  })

  it('refuses when the older proposal holds rows the new one leaves out: superseding would drop them', async () => {
    const { result } = await check([op({ params: { tx_ids: [TX_1, TX_2] } })], 'categorize_transaction', { transaction_id: TX_1 })

    expect(result).toEqual({
      kind: 'claimed',
      claims: [{ operation_id: 'op-1', operation_type: 'bulk_book_transactions', status: 'pending', created_at: '2026-10-16T08:00:00.000Z', transaction_ids: [TX_1] }],
    })
  })

  it('refuses a proposal being approved right now, the identical one included', async () => {
    const identical = await check([op({ status: 'committing' })], 'bulk_book_transactions', { tx_ids: [TX_1], entry_description: 'Avgifter' })
    expect(identical.result.kind).toBe('claimed')
    const changed = await check([op({ status: 'committing' })], 'bulk_book_transactions', { tx_ids: [TX_1], entry_description: 'Ny' })
    expect(changed.result.kind).toBe('claimed')
  })

  it('refuses all when any one claim is not supersedable, oldest first', async () => {
    const { result } = await check(
      [
        op({ id: 'op-late', created_at: '2026-10-16T09:00:00.000Z', params: { tx_ids: [TX_2] } }),
        op({ id: 'op-foreign', actor_id: 'key-2', created_at: '2026-10-15T09:00:00.000Z', params: { tx_ids: [TX_1] } }),
      ],
      'bulk_book_transactions',
      { tx_ids: [TX_1, TX_2] },
    )

    expect(result.kind).toBe('claimed')
    if (result.kind === 'claimed') expect(result.claims.map((c) => c.operation_id)).toEqual(['op-foreign', 'op-late'])
  })

  it('throws when the read fails: staging blind would bring the second card back', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'canceling statement due to statement timeout', code: '57014' } })

    await expect(
      checkTransactionClaims(supabase as never, 'company-1', 'categorize_transaction', { transaction_id: TX_1 }, AGENT),
    ).rejects.toThrow('statement timeout')
  })
})

describe('supersedeTransactionClaims', () => {
  const replacement = { operationId: 'op-new', stager: AGENT, actorLabel: 'ChatGPT', channel: 'mcp' as const }

  it('rejects the older proposals through the reject path, as superseded, naming the new operation', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'pending', operation_type: 'bulk_book_transactions', risk_level: 'high' }], error: null })
    enqueue({ data: [{ id: 'op-1' }], error: null }) // CAS update

    const rejected = await supersedeTransactionClaims(supabase as never, 'company-1', [op({})] as never, replacement)

    expect(rejected).toEqual(['op-1'])
    const update = findCall('pending_operations', 'update')?.[0] as Record<string, unknown>
    expect(update).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
      rejection_reason: 'Ersatt av ett nyare förslag för samma banktransaktioner (op-new).',
      result_data: { rejected_by: 'user-1', rejected_via: 'api_key', actor_id: 'key-1' },
    })
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'PendingOperationRejected',
        aggregateId: 'op-1',
        payload: expect.objectContaining({ channel: 'mcp' }),
        actor: { type: 'api_key', id: 'key-1', label: 'ChatGPT' },
      }),
    )
  })

  it('leaves an operation approved in between as it is, and reports only what it rejected', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-1', status: 'committed', operation_type: 'bulk_book_transactions', risk_level: 'high' }], error: null })

    const rejected = await supersedeTransactionClaims(supabase as never, 'company-1', [op({})] as never, replacement)

    expect(rejected).toEqual([])
  })

  it('never throws: the new operation is already staged', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(supersedeTransactionClaims(supabase as never, 'company-1', [op({})] as never, replacement)).resolves.toEqual([])
  })
})

describe('openTransactionClaims', () => {
  it('maps each listed row to the open proposal that holds it, in one read for the whole page', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'op-bulk', operation_type: 'bulk_book_transactions', params: { tx_ids: [TX_1, TX_3] } },
        { id: 'op-cat', operation_type: 'categorize_transaction', params: { transaction_id: TX_2 } },
      ],
      error: null,
    })

    const claims = await openTransactionClaims(supabase as never, 'company-1', [TX_1, TX_2])

    // TX_3 is in the proposal but not on the page: not in the answer.
    expect([...claims]).toEqual([[TX_1, 'op-bulk'], [TX_2, 'op-cat']])
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(findCalls('pending_operations', 'eq')).toEqual([['company_id', 'company-1']])
    // The staging check's definition of open and of a claiming type.
    expect(findCalls('pending_operations', 'in')).toEqual([
      ['status', ['pending', 'committing']],
      ['operation_type', ['categorize_transaction', 'bulk_book_transactions']],
    ])
  })

  it('answers the older proposal when two hold one row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The read is ordered oldest first.
    enqueue({
      data: [
        { id: 'op-older', operation_type: 'categorize_transaction', params: { transaction_id: TX_1 } },
        { id: 'op-newer', operation_type: 'bulk_book_transactions', params: { tx_ids: [TX_1] } },
      ],
      error: null,
    })

    const claims = await openTransactionClaims(supabase as never, 'company-1', [TX_1])

    expect(claims.get(TX_1)).toBe('op-older')
  })

  it('reads nothing for an empty page', async () => {
    const { supabase } = createQueuedMockSupabase()

    expect((await openTransactionClaims(supabase as never, 'company-1', [])).size).toBe(0)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws on a failed read: a row listed without its proposal reads as free', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'statement timeout' } })

    await expect(openTransactionClaims(supabase as never, 'company-1', [TX_1])).rejects.toThrow('statement timeout')
  })
})

describe('transactionAlreadyStagedFailure', () => {
  it('is the v1 outcome naming the operations', () => {
    const claims = [
      { operation_id: 'op-1', operation_type: 'categorize_transaction', status: 'pending', created_at: '2026-10-16T08:00:00.000Z', transaction_ids: [TX_1] },
    ]
    expect(transactionAlreadyStagedFailure(claims)).toEqual({
      ok: false,
      code: 'TRANSACTION_ALREADY_STAGED',
      details: { pending_operations: claims },
    })
  })
})
