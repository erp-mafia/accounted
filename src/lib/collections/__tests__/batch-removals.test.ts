import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createPagedMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import { loadBatchRemovals } from '../batch-removals'

/**
 * The items taken out of a pending daily batch. Both commits send the
 * staged items less these, so a removal left unread past PostgREST's 1000
 * rows would be sent anyway.
 */

const removal = (i: number) => ({
  invoice_id: `inv-${i}`,
  kind: 'reminder',
  removed_by: 'user-1',
  removed_at: new Date(Date.UTC(2026, 11, 17, 8, 0, i % 60)).toISOString(),
})

describe('loadBatchRemovals', () => {
  it('reads every removal, past one page', async () => {
    const rows = Array.from({ length: 1201 }, (_, i) => removal(i))
    const mock = createPagedMockSupabase({ collection_batch_removals: rows })
    const read = await loadBatchRemovals(mock.supabase as unknown as SupabaseClient, 'company-1', 'op-1')
    expect(read).toHaveLength(1201)
    expect(read.at(-1)).toEqual(rows[1200])
  })

  it('reads the batch of this company, in a stable order', async () => {
    const mock = createTableMockSupabase({ collection_batch_removals: { data: [removal(1)] } })
    await loadBatchRemovals(mock.supabase as unknown as SupabaseClient, 'company-1', 'op-1')
    expect(mock.findCalls('collection_batch_removals', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['pending_operation_id', 'op-1'],
    ])
    expect(mock.findCalls('collection_batch_removals', 'order')).toEqual([
      ['removed_at', { ascending: true }],
      ['id', { ascending: true }],
    ])
  })

  it('throws when the removals cannot be read: sending without them could send an unticked item', async () => {
    const mock = createTableMockSupabase({ collection_batch_removals: { data: null, error: { message: 'permission denied' } } })
    await expect(loadBatchRemovals(mock.supabase as unknown as SupabaseClient, 'company-1', 'op-1')).rejects.toThrow(
      'collection_batch_removals lookup failed: permission denied',
    )
  })
})
