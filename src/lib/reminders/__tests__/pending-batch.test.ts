import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readPendingReminderBatch } from '../pending-batch'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const supabase = mockSupabase as unknown as SupabaseClient
const COMPANY = 'company-1'

const item = (invoiceId: string) => ({ kind: 'reminder', invoice_id: invoiceId, level: 1, bank: 'fresh' })

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('readPendingReminderBatch', () => {
  it('answers the pending batch with the staged items less the removed ones', async () => {
    enqueue({ data: [{ id: 'op-1', params: { items: [item('i1'), item('i2'), item('i3')] } }], error: null })
    enqueue({ data: [{ invoice_id: 'i2' }], error: null })
    const read = await readPendingReminderBatch(supabase, COMPANY)
    expect(read).toEqual({ ok: true, batch: { id: 'op-1', items: [item('i1'), item('i3')] } })
    expect(findCalls('pending_operations', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['operation_type', 'reminder_daily_batch'],
      ['status', 'pending'],
    ])
    expect(findCalls('collection_batch_removals', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['pending_operation_id', 'op-1'],
      ['kind', 'reminder'],
    ])
  })

  it('answers no batch when none is pending, without reading removals', async () => {
    enqueue({ data: [], error: null })
    await expect(readPendingReminderBatch(supabase, COMPANY)).resolves.toEqual({ ok: true, batch: null })
    expect(mockSupabase.from).not.toHaveBeenCalledWith('collection_batch_removals')
  })

  it('answers a batch with nothing staged as empty, without reading removals', async () => {
    enqueue({ data: [{ id: 'op-1', params: { items: [] } }], error: null })
    await expect(readPendingReminderBatch(supabase, COMPANY)).resolves.toEqual({ ok: true, batch: { id: 'op-1', items: [] } })
    expect(mockSupabase.from).not.toHaveBeenCalledWith('collection_batch_removals')
  })

  it('fails rather than counting a batch whose removals cannot be read', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    await expect(readPendingReminderBatch(supabase, COMPANY)).resolves.toEqual({ ok: false, error: { message: 'boom' } })
    enqueue({ data: [{ id: 'op-1', params: { items: [item('i1')] } }], error: null })
    enqueue({ data: null, error: { message: 'denied' } })
    await expect(readPendingReminderBatch(supabase, COMPANY)).resolves.toEqual({ ok: false, error: { message: 'denied' } })
  })
})
