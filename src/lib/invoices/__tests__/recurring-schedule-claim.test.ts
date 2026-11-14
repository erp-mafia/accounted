import { describe, it, expect, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  claimRecurringScheduleRun,
  holdRecurringScheduleRun,
  releaseRecurringScheduleRun,
  scheduleRecordsInvoice,
} from '../recurring-schedule-claim'

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

describe('claimRecurringScheduleRun with what the claim writes beside it', () => {
  beforeEach(() => reset())

  it('writes the extra columns in the same UPDATE as the claim', async () => {
    enqueue({ data: [{ id: 's-1' }] })

    await claimRecurringScheduleRun(supabase as never, { id: 's-1', company_id: 'c-1', last_run_at: null }, CLAIM_TS, {
      last_run_warning: 'held',
    })

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([[{ last_run_at: CLAIM_TS, last_run_warning: 'held' }]])
  })
})

describe('holdRecurringScheduleRun', () => {
  beforeEach(() => reset())
  const schedule = { id: 's-1', company_id: 'c-1', last_run_at: '2026-10-01T06:00:00.000Z' }
  const HOLD_TS = '2026-11-10T07:00:00.001Z'

  it('moves the claim on to the hold with the held warning, only while this run holds the claim', async () => {
    enqueue({ data: [{ id: 's-1' }] })

    await expect(holdRecurringScheduleRun(supabase as never, schedule, CLAIM_TS, HOLD_TS, 'held')).resolves.toBe('held')

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([[{ last_run_at: HOLD_TS, last_run_warning: 'held' }]])
    // The record moves last_run_at off the claim, so the claim alone tells a
    // landed record from a run still to be held.
    expect(findCalls('recurring_invoice_schedules', 'eq')).toEqual([
      ['id', 's-1'],
      ['company_id', 'c-1'],
      ['last_run_at', CLAIM_TS],
    ])
  })

  it('answers moved when no row matched and unknown when the write failed', async () => {
    enqueue({ data: [] })
    await expect(holdRecurringScheduleRun(supabase as never, schedule, CLAIM_TS, HOLD_TS, 'held')).resolves.toBe('moved')

    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(holdRecurringScheduleRun(supabase as never, schedule, CLAIM_TS, HOLD_TS, 'held')).resolves.toBe('unknown')
  })
})

describe('scheduleRecordsInvoice (accounted#211)', () => {
  beforeEach(() => reset())
  const schedule = { id: 's-1', company_id: 'c-1', last_run_at: '2026-10-01T06:00:00.000Z' }

  it('reads the schedule back for this run\'s invoice, written there only by this run\'s record', async () => {
    enqueue({ data: [{ id: 's-1' }] })

    await expect(scheduleRecordsInvoice(supabase as never, schedule, 'inv-1')).resolves.toBe(true)

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([])
    expect(findCalls('recurring_invoice_schedules', 'eq')).toEqual([
      ['id', 's-1'],
      ['company_id', 'c-1'],
      ['last_invoice_id', 'inv-1'],
    ])
  })

  it('answers false when the schedule names another invoice, or when the read fails', async () => {
    enqueue({ data: [] })
    await expect(scheduleRecordsInvoice(supabase as never, schedule, 'inv-1')).resolves.toBe(false)

    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(scheduleRecordsInvoice(supabase as never, schedule, 'inv-1')).resolves.toBe(false)
  })
})

describe('releaseRecurringScheduleRun from a hold', () => {
  beforeEach(() => reset())

  it('gives the run back only while the row still holds the given token, and answers whether it did', async () => {
    const schedule = { id: 's-1', company_id: 'c-1', last_run_at: '2026-10-01T06:00:00.000Z' }
    enqueue({ data: [{ id: 's-1' }] })
    await expect(releaseRecurringScheduleRun(supabase as never, schedule, '2026-11-10T07:00:00.001Z', { last_run_warning: 'x' })).resolves.toBe(true)
    expect(findCalls('recurring_invoice_schedules', 'eq')).toContainEqual(['last_run_at', '2026-11-10T07:00:00.001Z'])

    enqueue({ data: [] })
    await expect(releaseRecurringScheduleRun(supabase as never, schedule, '2026-11-10T07:00:00.001Z')).resolves.toBe(false)
    enqueue({ data: null, error: { message: 'connection reset' } })
    await expect(releaseRecurringScheduleRun(supabase as never, schedule, '2026-11-10T07:00:00.001Z')).resolves.toBe(false)
  })
})
