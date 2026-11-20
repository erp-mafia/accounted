import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { withdrawPendingReminderBatches } from '../withdraw'

const NOW = new Date('2026-12-17T11:00:00Z')

describe('withdrawPendingReminderBatches', () => {
  it("rejects the company's pending reminder batch as the cron does for a company that turned reminders off", async () => {
    const mock = createTableMockSupabase({ pending_operations: { data: [{ id: 'op-1' }] } })
    expect(await withdrawPendingReminderBatches(mock.supabase as unknown as SupabaseClient, 'company-1', NOW)).toBe(1)
    expect(mock.findCall('pending_operations', 'update')).toEqual([
      {
        status: 'rejected',
        rejection_category: 'superseded',
        result_data: { auto_rejected: true, reason: 'reminders_off' },
        resolved_at: '2026-12-17T11:00:00.000Z',
      },
    ])
    // Only this company's batch, and only while it is still pending: an approval underway is never overwritten.
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['operation_type', 'reminder_daily_batch'],
      ['status', 'pending'],
    ])
  })

  it('withdraws nothing when nothing is pending', async () => {
    const mock = createTableMockSupabase({ pending_operations: { data: [] } })
    expect(await withdrawPendingReminderBatches(mock.supabase as unknown as SupabaseClient, 'company-1', NOW)).toBe(0)
  })

  it('throws when the write fails, so the caller can log it', async () => {
    const mock = createTableMockSupabase({ pending_operations: { data: null, error: { message: 'boom' } } })
    await expect(withdrawPendingReminderBatches(mock.supabase as unknown as SupabaseClient, 'company-1', NOW)).rejects.toThrow(/withdrawal failed/)
  })
})
