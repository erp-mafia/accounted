import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { cleanBatchStreak, loadAutomaticReminderState, setAutomaticReminders } from '../automatic'

const NOW = new Date('2026-12-20T09:00:00Z')
const committed = (id: string) => ({ id, status: 'committed' })

function db(batches: unknown[], removals: unknown[] = [], settings: Record<string, unknown> = { send_invoice_reminders: true, reminders_automatic_at: null }) {
  return createTableMockSupabase({
    pending_operations: { data: batches },
    collection_batch_removals: { data: removals },
    company_settings: { data: settings },
  })
}

describe('cleanBatchStreak', () => {
  it('counts the newest batches in a row approved without anything taken out', async () => {
    expect(await cleanBatchStreak(db([committed('c'), committed('b'), committed('a')]).supabase as unknown as SupabaseClient, 'company-1')).toBe(3)
    expect(await cleanBatchStreak(db([committed('c'), committed('b'), committed('a')], [{ pending_operation_id: 'b' }]).supabase as unknown as SupabaseClient, 'company-1')).toBe(1)
  })

  it('breaks at a rejected batch, and is nothing without batches', async () => {
    expect(await cleanBatchStreak(db([committed('c'), { id: 'b', status: 'rejected' }, committed('a')]).supabase as unknown as SupabaseClient, 'company-1')).toBe(1)
    expect(await cleanBatchStreak(db([{ id: 'c', status: 'rejected' }]).supabase as unknown as SupabaseClient, 'company-1')).toBe(0)
    expect(await cleanBatchStreak(db([]).supabase as unknown as SupabaseClient, 'company-1')).toBe(0)
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
