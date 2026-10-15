/**
 * gnubok_approve_pending_operation resent after the approval went through.
 *
 * The stateless MCP revision recovers a broken call by sending it again. An
 * approval whose answer was lost has already committed; the repeat must
 * neither commit again (the claim in commitPendingOperation guarantees that,
 * see lib/pending-operations/__tests__/commit-double-approval.test.ts) nor
 * answer a bare conflict an agent could read as "stage it again", which is
 * how a second verifikat would get made. It answers the stored outcome.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const commitSpy = vi.fn()
vi.mock('@/lib/pending-operations/commit', () => ({
  commitPendingOperation: (...args: unknown[]) => commitSpy(...args),
}))

import { tools } from '../server'

const approve = tools.find((t) => t.name === 'gnubok_approve_pending_operation')!

function operation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-1',
    operation_type: 'create_voucher',
    company_id: 'company-1',
    status: 'pending',
    risk_level: 'high',
    params: {},
    result_data: null,
    ...overrides,
  }
}

const run = (supabase: unknown) =>
  approve.execute({ operation_id: 'op-1', confirmed: true }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }) as Promise<
    Record<string, unknown>
  >

beforeEach(() => vi.clearAllMocks())

describe('gnubok_approve_pending_operation: a resent approval', () => {
  it('answers the stored result of an operation already committed, without committing again', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ status: 'committed', result_data: { journal_entry_id: 'je-1', voucher_number: 'A12' } }), error: null })

    const result = await run(supabase)

    expect(commitSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'committed',
      operation_id: 'op-1',
      data: { journal_entry_id: 'je-1', voucher_number: 'A12' },
      operation_status: 'committed',
      idempotency_replay: true,
    })
  })

  it('answers the outcome of a concurrent approval that won the claim and settled meanwhile', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation(), error: null }) // read: still pending
    enqueue({ data: operation({ status: 'committed', result_data: { journal_entry_id: 'je-1' } }), error: null }) // re-read after the lost claim
    commitSpy.mockResolvedValue({ status: 'failed', error: 'Operation already claimed or resolved by another caller', http_status: 409 })

    const result = await run(supabase)

    expect(commitSpy).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ status: 'committed', data: { journal_entry_id: 'je-1' }, idempotency_replay: true })
  })

  it('keeps the conflict while the other approval is still committing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation(), error: null })
    enqueue({ data: operation({ status: 'committing' }), error: null })
    commitSpy.mockResolvedValue({ status: 'failed', error: 'Operation already claimed or resolved by another caller', http_status: 409 })

    const result = await run(supabase)

    expect(result).toMatchObject({ status: 'failed', error: 'Operation already claimed or resolved by another caller' })
    expect(result).not.toHaveProperty('idempotency_replay')
  })

  it('says a rejected operation was rejected and commits nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ status: 'rejected', result_data: { auto_rejected: true, reason: 'Transaktionen är redan bokförd.' } }), error: null })

    const result = await run(supabase)

    expect(commitSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'rejected',
      error: 'Transaktionen är redan bokförd.',
      auto_rejected: true,
      operation_status: 'rejected',
    })
  })

  it('still demands confirmed=true for a high-risk operation, settled or not', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: operation({ status: 'committed' }), error: null })
    await expect(
      approve.execute({ operation_id: 'op-1' }, 'company-1', 'user-1', supabase as never, { type: 'api_key' }),
    ).rejects.toThrow('confirmed=true')
    expect(commitSpy).not.toHaveBeenCalled()
  })
})
