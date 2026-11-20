import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { operationRowDouble } from './operation-row-double'

const mockAppend = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => 'event-1'))
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...a: unknown[]) => mockAppend(...a),
}))

import { withdrawPendingOperation, WITHDRAWN_LEAD, WITHDRAW_REASON_MAX_LENGTH } from '../withdraw'

type Row = Record<string, unknown>

const COMPANY_ID = 'company-1'
const OP_ID = 'op-1'
/** The connection that staged the operation: a key without pending_operations:approve. */
const STAGER = { userId: 'user-1', type: 'api_key', id: 'key-stager', label: 'Agenten' }

function stagedRow(overrides: Row = {}): Row {
  return {
    id: OP_ID,
    status: 'pending',
    user_id: 'user-1',
    actor_id: 'key-stager',
    result_data: null,
    operation_type: 'create_voucher',
    risk_level: 'high',
    ...overrides,
  }
}

/** The row behind a mock client; `beforeUpdate` is where another session claims it. */
function client(initial: Row | null, beforeUpdate?: (row: Row) => void) {
  const { state, resolver } = operationRowDouble(initial, beforeUpdate)
  return { ...createTableMockSupabase({ pending_operations: resolver }), state }
}

const withdraw = (supabase: unknown, overrides: Record<string, unknown> = {}) =>
  withdrawPendingOperation(supabase as never, {
    companyId: COMPANY_ID,
    id: OP_ID,
    actor: STAGER,
    channel: 'mcp',
    ...overrides,
  })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('withdrawPendingOperation', () => {
  it('closes the stager\'s own pending operation as withdrawn, with who and why', async () => {
    const { supabase, state } = client(stagedRow())

    const result = await withdraw(supabase, { reason: '  dubblett av op-2  ' })

    expect(result).toEqual({ ok: true, result: { outcome: 'withdrawn' } })
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({
      status: 'rejected',
      // The system's value: a withdrawal is nobody's verdict on the proposal.
      rejection_category: 'superseded',
      rejection_reason: `${WITHDRAWN_LEAD}: dubblett av op-2`,
      result_data: {
        withdrawn: true,
        rejected_by: 'user-1',
        rejected_via: 'api_key',
        actor_id: 'key-stager',
      },
    })
    expect(state.updates[0].resolved_at).toEqual(expect.any(String))
  })

  it('appends one audit row naming the withdrawing connection', async () => {
    const { supabase } = client(stagedRow())

    await withdraw(supabase)

    expect(mockAppend).toHaveBeenCalledTimes(1)
    expect(mockAppend.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY_ID,
      aggregateId: OP_ID,
      eventType: 'PendingOperationRejected',
      payload: { operation_id: OP_ID, operation_type: 'create_voucher', channel: 'mcp', withdrawn: true },
      actor: { type: 'api_key', id: 'key-stager', label: 'Agenten' },
    })
  })

  it('stores the lead alone when no reason is given, and cuts a long one', async () => {
    const bare = client(stagedRow())
    await withdraw(bare.supabase)
    expect(bare.state.updates[0].rejection_reason).toBe(`${WITHDRAWN_LEAD}.`)

    const long = client(stagedRow())
    await withdraw(long.supabase, { reason: 'x'.repeat(WITHDRAW_REASON_MAX_LENGTH + 50) })
    expect(long.state.updates[0].rejection_reason).toBe(`${WITHDRAWN_LEAD}: ${'x'.repeat(WITHDRAW_REASON_MAX_LENGTH)}`)
  })

  it.each([
    ['another connection of the same person', { actor_id: 'key-other' }],
    ['a person in the app', { actor_id: null }],
    ['the same key id under another user', { user_id: 'user-2' }],
  ])('refuses an operation staged by %s, and writes nothing', async (_who, overrides) => {
    const { supabase, state } = client(stagedRow(overrides))

    const result = await withdraw(supabase)

    expect(result).toEqual({ ok: true, result: { outcome: 'not_own' } })
    expect(state.updates).toEqual([])
    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('a caller without a credential id owns nothing', async () => {
    const { supabase, state } = client(stagedRow({ actor_id: null }))

    const result = await withdraw(supabase, { actor: { userId: 'user-1', type: 'user' } })

    expect(result).toEqual({ ok: true, result: { outcome: 'not_own' } })
    expect(state.updates).toEqual([])
  })

  it('does not say what state another stager\'s operation is in', async () => {
    const { supabase } = client(stagedRow({ actor_id: 'key-other', status: 'committed' }))
    expect(await withdraw(supabase)).toEqual({ ok: true, result: { outcome: 'not_own' } })
  })

  it.each(['committing', 'committed', 'failed_partial', 'unknown'])(
    'leaves an own operation that is %s as it is',
    async (status) => {
      const { supabase, state } = client(stagedRow({ status }))

      const result = await withdraw(supabase)

      expect(result).toEqual({ ok: true, result: { outcome: 'not_pending', status } })
      expect(state.updates).toEqual([])
      expect(mockAppend).not.toHaveBeenCalled()
    },
  )

  it('an own operation a person rejected is not pending, not "already withdrawn"', async () => {
    const { supabase } = client(stagedRow({ status: 'rejected', result_data: { rejected_by: 'user-1', rejected_via: 'user' } }))
    expect(await withdraw(supabase)).toEqual({ ok: true, result: { outcome: 'not_pending', status: 'rejected' } })
  })

  it('is idempotent: a second withdrawal answers already_withdrawn and writes nothing more', async () => {
    const { supabase, state } = client(stagedRow())

    expect(await withdraw(supabase)).toEqual({ ok: true, result: { outcome: 'withdrawn' } })
    expect(await withdraw(supabase)).toEqual({ ok: true, result: { outcome: 'already_withdrawn' } })

    expect(state.updates).toHaveLength(1)
    expect(mockAppend).toHaveBeenCalledTimes(1)
  })

  it('never stamps over an operation an approval claimed between the read and the write', async () => {
    const { supabase, state } = client(stagedRow(), (row) => {
      row.status = 'committing'
    })

    const result = await withdraw(supabase)

    expect(result).toEqual({ ok: true, result: { outcome: 'lost_race' } })
    expect(state.row?.status).toBe('committing')
    expect(state.updates).toEqual([])
    expect(mockAppend).not.toHaveBeenCalled()
  })

  it('answers not_found for an id the company does not have', async () => {
    const { supabase, calls } = client(null)

    expect(await withdraw(supabase)).toEqual({ ok: true, result: { outcome: 'not_found' } })
    expect(calls.filter((c) => c.method === 'eq').map((c) => c.args)).toEqual(
      expect.arrayContaining([['company_id', COMPANY_ID]]),
    )
  })

  it('returns the read error with its code', async () => {
    const mock = createTableMockSupabase({
      pending_operations: { data: null, error: { message: 'invalid input syntax for type uuid', code: '22P02' } },
    })

    expect(await withdraw(mock.supabase)).toEqual({
      ok: false,
      stage: 'fetch',
      error: { message: 'invalid input syntax for type uuid', code: '22P02' },
    })
  })
})
