import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { cleanBatchStreak, loadAutomaticReminderState, setAutomaticReminders } from '../automatic'

const NOW = new Date('2026-12-20T09:00:00Z')
const ENABLED_AT = '2026-12-01T08:00:00Z'
/** A committed batch as the commit leaves it: reminders staged, sent, nothing skipped. */
const committed = (id: string, result: { sent_count?: number; skipped?: unknown[]; item_count?: number } = {}) => ({
  id,
  status: 'committed',
  item_count: result.item_count ?? 2,
  sent_count: result.sent_count ?? 2,
  skipped: result.skipped ?? [],
})

function db(
  batches: unknown[],
  removals: unknown[] = [],
  settings: Record<string, unknown> = { send_invoice_reminders: true, reminders_enabled_at: ENABLED_AT, reminders_automatic_at: null },
) {
  return createTableMockSupabase({
    pending_operations: { data: batches },
    collection_batch_removals: { data: removals },
    company_settings: { data: settings },
  })
}

const streak = (mock: ReturnType<typeof db>) => cleanBatchStreak(mock.supabase as unknown as SupabaseClient, 'company-1')

describe('cleanBatchStreak', () => {
  it('counts the newest batches in a row approved without anything taken out', async () => {
    expect(await streak(db([committed('c'), committed('b'), committed('a')]))).toBe(3)
    expect(await streak(db([committed('c'), committed('b'), committed('a')], [{ pending_operation_id: 'b' }]))).toBe(1)
  })

  it('breaks at a rejected batch, and is nothing without batches', async () => {
    expect(await streak(db([committed('c'), { id: 'b', status: 'rejected', item_count: 1 }, committed('a')]))).toBe(1)
    expect(await streak(db([{ id: 'c', status: 'rejected', item_count: 1 }]))).toBe(0)
    expect(await streak(db([]))).toBe(0)
  })

  it('counts only batches staged since reminders were last turned on', async () => {
    const mock = db([committed('c'), committed('b'), committed('a')])
    await streak(mock)
    expect(mock.findCalls('pending_operations', 'gt')).toEqual([['created_at', ENABLED_AT]])
    // Reminders off: no streak at all.
    expect(await streak(db([committed('c'), committed('b'), committed('a')], [], { send_invoice_reminders: false, reminders_enabled_at: null }))).toBe(0)
  })

  it('breaks at a batch that sent nothing, or found an approved reminder changed at the send', async () => {
    expect(await streak(db([committed('c'), committed('b', { sent_count: 0, skipped: [{ reason: 'paid' }] }), committed('a')]))).toBe(1)
    expect(await streak(db([committed('c', { sent_count: 1, skipped: [{ reason: 'changed' }] }), committed('b'), committed('a')]))).toBe(0)
    // A payment that arrived before the send is not a change to the batch.
    expect(await streak(db([committed('c', { sent_count: 1, skipped: [{ reason: 'paid' }] }), committed('b'), committed('a')]))).toBe(3)
  })

  it('passes over a batch that only listed invoices, whatever became of it', async () => {
    const listOnly = (id: string, status: string) => ({ id, status, item_count: 0, sent_count: 0, skipped: [] })
    expect(await streak(db([committed('c'), listOnly('l1', 'rejected'), committed('b'), listOnly('l2', 'committed'), committed('a')]))).toBe(3)
  })
})

describe('loadAutomaticReminderState', () => {
  it('reads whether it is on and whether it may be offered', async () => {
    const state = await loadAutomaticReminderState(db([committed('c'), committed('b'), committed('a')]).supabase as unknown as SupabaseClient, 'company-1')
    expect(state).toEqual({ on: false, since: null, eligible: true, cleanStreak: 3 })
  })
})

describe('setAutomaticReminders', () => {
  it('turns it on after three clean batches, as the person', async () => {
    const mock = db([committed('c'), committed('b'), committed('a')])
    const outcome = await setAutomaticReminders(mock.supabase as unknown as SupabaseClient, { companyId: 'company-1', enabled: true, userId: 'admin-1', now: NOW })
    expect(outcome.ok).toBe(true)
    expect(mock.payloads('company_settings', 'update')).toEqual([{ reminders_automatic_at: NOW.toISOString(), reminders_automatic_by: 'admin-1' }])
  })

  it('refuses before three clean batches, or while reminders are off', async () => {
    const early = db([committed('b'), committed('a')])
    expect(await setAutomaticReminders(early.supabase as unknown as SupabaseClient, { companyId: 'company-1', enabled: true, userId: 'admin-1', now: NOW })).toEqual({
      ok: false,
      code: 'REMINDERS_AUTOMATIC_NOT_YET',
    })
    const off = db([committed('c'), committed('b'), committed('a')], [], { send_invoice_reminders: false })
    expect(await setAutomaticReminders(off.supabase as unknown as SupabaseClient, { companyId: 'company-1', enabled: true, userId: 'admin-1', now: NOW })).toEqual({
      ok: false,
      code: 'REMINDERS_OFF',
    })
    expect(early.payloads('company_settings', 'update')).toEqual([])
  })

  it('turns it off whatever the batches say', async () => {
    const mock = db([])
    await setAutomaticReminders(mock.supabase as unknown as SupabaseClient, { companyId: 'company-1', enabled: false, userId: 'admin-1', now: NOW })
    expect(mock.payloads('company_settings', 'update')).toEqual([{ reminders_automatic_at: null, reminders_automatic_by: null }])
  })
})
