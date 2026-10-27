import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { supersedeIdenticalProposals } from '../identical-proposal'

const STAGER = { userId: 'user-1', actorType: 'api_key', actorId: 'key-1' }
const REPLACEMENT = { stager: STAGER, actorLabel: 'Claude (Anthropic)', channel: 'mcp' as const }

beforeEach(() => vi.clearAllMocks())

describe('supersedeIdenticalProposals', () => {
  it('reads nothing for a type where two identical proposals can be two real events', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()

    const ids = await supersedeIdenticalProposals(
      supabase as never,
      'company-1',
      { id: 'op-new', operationType: 'create_voucher', params: { lines: [] }, batchId: null },
      REPLACEMENT,
    )

    expect(ids).toEqual([])
    expect(findCalls('pending_operations', 'select')).toHaveLength(0)
  })

  it('compares params as stored jsonb returns them, key order and undefined aside', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'op-older', params: { mappings: { '1930': '1930' }, filename: 'a.se' } }], error: null })
    enqueue({ data: [{ id: 'op-older', status: 'pending', operation_type: 'import_sie', risk_level: 'high' }], error: null })
    enqueue({ data: [{ id: 'op-older' }], error: null })

    const ids = await supersedeIdenticalProposals(
      supabase as never,
      'company-1',
      { id: 'op-new', operationType: 'import_sie', params: { filename: 'a.se', mappings: { '1930': '1930' }, note: undefined }, batchId: null },
      REPLACEMENT,
    )

    expect(ids).toEqual(['op-older'])
  })

  it('looks within the batch the new operation belongs to', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()

    await supersedeIdenticalProposals(
      supabase as never,
      'company-1',
      { id: 'op-new', operationType: 'reverse_entry', params: { entry_id: 'e-1' }, batchId: 'batch-1' },
      REPLACEMENT,
    )
    expect(findCall('pending_operations', 'is')).toBeUndefined()

    const other = createQueuedMockSupabase()
    await supersedeIdenticalProposals(
      other.supabase as never,
      'company-1',
      { id: 'op-new', operationType: 'reverse_entry', params: { entry_id: 'e-1' }, batchId: null },
      REPLACEMENT,
    )
    expect(other.findCalls('pending_operations', 'is')).toContainEqual(['batch_id', null])
  })

  it('never throws: a failed read leaves the twin pending', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(
      supersedeIdenticalProposals(
        supabase as never,
        'company-1',
        { id: 'op-new', operationType: 'reverse_entry', params: { entry_id: 'e-1' }, batchId: null },
        REPLACEMENT,
      ),
    ).resolves.toEqual([])
  })
})
