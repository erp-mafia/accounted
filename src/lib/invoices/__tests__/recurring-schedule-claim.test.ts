import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { claimRecurringScheduleRun, releaseRecurringScheduleRun } from '../recurring-schedule-claim'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const CLAIM_TS = '2026-11-10T07:00:00.000Z'

describe('claimRecurringScheduleRun (accounted#58)', () => {
  beforeEach(() => reset())

  it('claims by comparing last_run_at with the value read', async () => {
    enqueue({ data: [{ id: 's-1' }] })
    const schedule = { id: 's-1', company_id: 'c-1', last_run_at: '2026-10-01T06:00:00.000Z' }

    await expect(claimRecurringScheduleRun(supabase as never, schedule, CLAIM_TS)).resolves.toBe(true)

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([[{ last_run_at: CLAIM_TS }]])
    const eqs = findCalls('recurring_invoice_schedules', 'eq')
    expect(eqs).toContainEqual(['id', 's-1'])
    expect(eqs).toContainEqual(['company_id', 'c-1'])
    expect(eqs).toContainEqual(['last_run_at', '2026-10-01T06:00:00.000Z'])
  })

  it('claims a schedule that never ran on last_run_at IS NULL', async () => {
    enqueue({ data: [{ id: 's-1' }] })

    await expect(
      claimRecurringScheduleRun(supabase as never, { id: 's-1', company_id: 'c-1', last_run_at: null }, CLAIM_TS),
    ).resolves.toBe(true)

    expect(findCalls('recurring_invoice_schedules', 'is')).toEqual([['last_run_at', null]])
  })

  it('loses the claim when no row still holds the value read', async () => {
    enqueue({ data: [] })
    await expect(
      claimRecurringScheduleRun(supabase as never, { id: 's-1', company_id: 'c-1', last_run_at: null }, CLAIM_TS),
    ).resolves.toBe(false)
  })

  it('throws when the claim write fails', async () => {
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(
      claimRecurringScheduleRun(supabase as never, { id: 's-1', company_id: 'c-1', last_run_at: null }, CLAIM_TS),
    ).rejects.toThrow('connection reset')
  })
})

describe('releaseRecurringScheduleRun', () => {
  beforeEach(() => reset())

  it('restores the last_run_at read, with the extra fields, only while the row holds this claim', async () => {
    enqueue({ error: null })
    const schedule = { id: 's-1', company_id: 'c-1', last_run_at: '2026-10-01T06:00:00.000Z' }

    await releaseRecurringScheduleRun(supabase as never, schedule, CLAIM_TS, { last_run_warning: 'x' })

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([
      [{ last_run_at: '2026-10-01T06:00:00.000Z', last_run_warning: 'x' }],
    ])
    expect(findCalls('recurring_invoice_schedules', 'eq')).toContainEqual(['last_run_at', CLAIM_TS])
  })
})
