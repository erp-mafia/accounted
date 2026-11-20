import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { createFakeReminderChannel } from '../channels/fake'
import type { ReminderBatchItem, ReminderBatchParams } from '../batch'

vi.mock('../dispatch', () => ({ dispatchReminder: vi.fn() }))
vi.mock('@/lib/collections/batch-removals', () => ({ loadBatchRemovals: vi.fn() }))

const { dispatchReminder } = await import('../dispatch')
const { loadBatchRemovals } = await import('@/lib/collections/batch-removals')
const { commitReminderDailyBatch, reminderBatchApprovalRefusal, reminderSkipReason } = await import('../batch-commit')

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

function item(invoiceId: string, overrides: Partial<ReminderBatchItem> = {}): ReminderBatchItem {
  return {
    kind: 'reminder',
    invoice_id: invoiceId,
    invoice_number: 'F-1',
    customer_name: 'Kund AB',
    recipient: 'kund@example.se',
    due_date: '2026-12-02',
    level: 1,
    remaining_amount: 1250,
    currency: 'SEK',
    bank: 'fresh',
    ...overrides,
  }
}

const PARAMS: ReminderBatchParams = {
  batch_date: '2026-12-17',
  items: [item(A), item(B, { bank: 'no_bank', level: 2 }), item(C)],
  excluded: [],
}

const db = createTableMockSupabase().supabase as unknown as SupabaseClient
const commit = (params: unknown = PARAMS) =>
  commitReminderDailyBatch(
    { userId: 'user-1', companyId: 'company-1', operation: { id: 'op-1', params: params as Record<string, unknown> } },
    { db, channel: createFakeReminderChannel(), log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } as never },
  )

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadBatchRemovals).mockResolvedValue([])
})

describe('reminderBatchApprovalRefusal', () => {
  const settings = (send: boolean | null) =>
    createTableMockSupabase({ company_settings: { data: { send_invoice_reminders: send } } }).supabase as unknown as SupabaseClient

  it('lets an owner or administrator approve while reminders are on', async () => {
    expect(await reminderBatchApprovalRefusal(settings(true), 'company-1', { isAdmin: async () => true, sendingEnabled: true })).toBeNull()
  })

  it('refuses anyone else, and a batch of a company that turned reminders off', async () => {
    expect(await reminderBatchApprovalRefusal(settings(true), 'company-1', { isAdmin: async () => false, sendingEnabled: true })).toMatchObject({
      code: 'COLLECTION_BATCH_ADMIN_ONLY',
      status: 403,
    })
    expect(await reminderBatchApprovalRefusal(settings(false), 'company-1', { isAdmin: async () => true, sendingEnabled: true })).toMatchObject({
      code: 'REMINDERS_OFF',
      status: 409,
      messageSv: expect.stringContaining('avstängda'),
    })
    expect(await reminderBatchApprovalRefusal(settings(true), 'company-1', { isAdmin: async () => true, sendingEnabled: false })).toMatchObject({
      code: 'REMINDERS_OFF',
    })
  })
})

describe('commitReminderDailyBatch', () => {
  it('sends the items less the ones taken out, approved, attesting the bank the reviewer saw unchecked', async () => {
    vi.mocked(loadBatchRemovals).mockResolvedValue([{ invoice_id: C, kind: 'reminder' as never, removed_by: 'user-1', removed_at: '2026-12-17T10:00:00Z' }])
    vi.mocked(dispatchReminder)
      .mockResolvedValueOnce({ status: 'sent', reminderId: 'rem-a', level: 1, providerMessageId: 'm-a', recorded: true })
      .mockResolvedValueOnce({ status: 'sent', reminderId: 'rem-b', level: 2, providerMessageId: 'm-b', recorded: true })

    const outcome = await commit()

    expect(outcome).toEqual({
      ok: true,
      data: {
        batch_date: '2026-12-17',
        sent: [
          { invoice_id: A, level: 1, reminder_id: 'rem-a' },
          { invoice_id: B, level: 2, reminder_id: 'rem-b' },
        ],
        skipped: [],
        sent_count: 2,
        skipped_count: 0,
      },
    })
    expect(vi.mocked(dispatchReminder).mock.calls.map(([, input]) => input)).toEqual([
      { companyId: 'company-1', invoiceId: A, level: 1, actorUserId: 'user-1', mode: 'approved', bankAttested: false },
      { companyId: 'company-1', invoiceId: B, level: 2, actorUserId: 'user-1', mode: 'approved', bankAttested: true },
    ])
  })

  it('reports each item that did not go out with one reason, and goes on after an error', async () => {
    vi.mocked(dispatchReminder)
      .mockResolvedValueOnce({ status: 'skipped', reason: 'paid' })
      .mockResolvedValueOnce({ status: 'failed', reminderId: 'rem-b', code: 'EMAIL_SEND_FAILED', outcomeUnknown: false })
      .mockRejectedValueOnce(new Error('database down'))

    const outcome = await commit()

    expect(outcome.ok && outcome.data.skipped).toEqual([
      { invoice_id: A, reason: 'paid', code: 'paid' },
      { invoice_id: B, reason: 'failed', code: 'EMAIL_SEND_FAILED' },
      { invoice_id: C, reason: 'error', code: 'INTERNAL_ERROR' },
    ])
    expect(outcome.ok && outcome.data.sent_count).toBe(0)
  })

  it('refuses params that are not a reminder batch', async () => {
    expect(await commit({ batch_date: 'nope' })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    expect(dispatchReminder).not.toHaveBeenCalled()
  })
})

describe('reminderSkipReason', () => {
  it('reads a possible payment or an unchecked bank as the bank, and the rest as changed', () => {
    expect(reminderSkipReason({ status: 'skipped', reason: 'possible_payment' })).toBe('bank')
    expect(reminderSkipReason({ status: 'skipped', reason: 'bank_not_fresh' })).toBe('bank')
    expect(reminderSkipReason({ status: 'skipped', reason: 'response' })).toBe('changed')
    expect(reminderSkipReason({ status: 'skipped', reason: 'changed' })).toBe('changed')
  })
})
