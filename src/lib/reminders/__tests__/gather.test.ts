import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeCompanySettings, makeCustomer, makeInvoice, type TableMockResolver } from '@/tests/helpers'
import type { BankCheckResult } from '@/lib/collections/bank-check'
import type { ReminderContext } from '../facts'
import type { ReminderHistoryEntry, ReminderInvoiceFacts } from '../policy'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
vi.mock('../bank', () => ({ checkReminderBank: vi.fn() }))
vi.mock('../dispatch', () => ({ dispatchReminder: vi.fn() }))

const { loadReminderContext } = await import('../facts')
const { checkReminderBank } = await import('../bank')
const { dispatchReminder } = await import('../dispatch')
const { createFakeReminderChannel } = await import('../channels/fake')
const { gatherReminderBatch, stageReminderBatch, runReminderBatchCron } = await import('../gather')

// 2026-12-17 at noon in Stockholm: level 1 of an invoice due 2026-12-02 (15 days) is due today.
const NOW = new Date('2026-12-17T11:00:00Z')
const COMPANY = 'company-1'
const ids = { due: '11111111-1111-4111-8111-111111111111', stale: '22222222-2222-4222-8222-222222222222', paid: '33333333-3333-4333-8333-333333333333', answered: '44444444-4444-4444-8444-444444444444', old: '55555555-5555-4555-8555-555555555555' }

function context(id: string, facts: Partial<ReminderInvoiceFacts> = {}, history: ReminderHistoryEntry[] = [], extra: Partial<ReminderContext> = {}): ReminderContext {
  return {
    invoice: makeInvoice({ id, invoice_number: `F-${id.slice(0, 4)}`, invoice_date: '2026-11-02', due_date: '2026-12-02', status: 'sent', currency: 'SEK' }),
    customer: makeCustomer({ name: 'Kund AB', email: 'kund@example.se' }),
    company: makeCompanySettings({ send_invoice_reminders: true, reminders_enabled_at: '2026-11-01T09:00:00Z' }),
    companyInactive: false,
    amount: 1250,
    facts: {
      kind: 'invoice',
      status: 'sent',
      invoiceDate: '2026-11-02',
      dueDate: '2026-12-02',
      remaining: 1250,
      credited: false,
      delivery: 'delivered',
      imported: false,
      autogiro: false,
      recipient: 'kund@example.se',
      customerExcluded: false,
      withCollections: false,
      ...facts,
    },
    history,
    ...extra,
  }
}

function bank(outcome: BankCheckResult['outcome']): BankCheckResult {
  return { outcome, freshness: outcome === 'pass' || outcome === 'candidates' ? 'fresh' : outcome, checkedAt: NOW.toISOString(), payeeAccounts: [], candidates: [], lastSyncedAt: null }
}

const CONTEXTS: Record<string, ReminderContext> = {
  [ids.due]: context(ids.due),
  [ids.stale]: context(ids.stale, { remaining: 400 }),
  [ids.paid]: context(ids.paid),
  [ids.answered]: context(ids.answered, {}, [
    { level: 1, status: 'sent', sentOn: '2026-12-01', providerStatus: 'delivered', responseType: 'disputed', legacy: false },
  ]),
  // Issued before reminders were turned on: never joins the ladder by itself, and is not listed.
  [ids.old]: context(ids.old, { invoiceDate: '2026-10-01' }),
}

function world(overrides: Parameters<typeof createTableMockSupabase>[0] = {}) {
  return createTableMockSupabase({
    company_settings: { data: { reminder_days_level_1: 15, reminder_days_level_2: 30, reminder_days_level_3: 45 } },
    invoices: { data: Object.keys(CONTEXTS).map((id) => ({ id })) },
    company_members: { data: [{ user_id: 'owner-1', role: 'owner' }] },
    ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => CONTEXTS[id]!)
  vi.mocked(checkReminderBank).mockImplementation(async (_db, ctx) =>
    bank(ctx.invoice.id === ids.stale ? 'stale' : ctx.invoice.id === ids.paid ? 'candidates' : 'pass'),
  )
})

describe('gatherReminderBatch', () => {
  it('stages the due reminders, marks an unchecked bank, and lists what a person should see', async () => {
    const { supabase, findCalls } = world()
    const batch = await gatherReminderBatch(supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })

    expect(batch.batchDate).toBe('2026-12-17')
    expect(batch.items).toEqual([
      expect.objectContaining({ kind: 'reminder', invoice_id: ids.due, level: 1, recipient: 'kund@example.se', remaining_amount: 1250, currency: 'SEK', bank: 'fresh' }),
      expect.objectContaining({ invoice_id: ids.stale, remaining_amount: 400, bank: 'stale' }),
    ])
    expect(batch.excluded).toEqual([
      { invoice_id: ids.paid, invoice_number: 'F-3333', customer_name: 'Kund AB', due_date: '2026-12-02', reason: 'possible_payment' },
      { invoice_id: ids.answered, invoice_number: 'F-4444', customer_name: 'Kund AB', due_date: '2026-12-02', reason: 'response' },
    ])
    // Only invoices past the first level's days are read: due on or before 2026-12-02.
    expect(findCalls('invoices', 'lte')).toEqual([['due_date', '2026-12-02']])
    // The bank is asked only for reminders that are due.
    expect(checkReminderBank).toHaveBeenCalledTimes(3)
  })

  it('reminds nobody for an archived, reset or sandbox company', async () => {
    vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => ({ ...CONTEXTS[id]!, companyInactive: true }))
    const batch = await gatherReminderBatch(world().supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })
    expect(batch).toEqual({ batchDate: '2026-12-17', items: [], excluded: [] })
  })
})

describe('stageReminderBatch', () => {
  const stage = (mock: ReturnType<typeof world>) => stageReminderBatch(mock.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })

  it('stages one pending operation under the owner, for a person to approve', async () => {
    const mock = world({ pending_operations: [{ data: [] }, { data: [] }, { data: { id: 'op-1' } }] })
    expect(await stage(mock)).toEqual({ status: 'staged', operationId: 'op-1', items: 2, excluded: 2, sent: 0 })
    const [row] = mock.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({
      company_id: COMPANY,
      user_id: 'owner-1',
      operation_type: 'reminder_daily_batch',
      status: 'pending',
      title: 'Påminnelser 2026-12-17: 2 fakturor att granska',
      actor_type: 'cron',
      risk_level: 'high',
      preview_data: { batch_date: '2026-12-17', item_count: 2, excluded_count: 2, levels: [2, 0, 0], unchecked_bank_count: 1, sent_automatically: 0 },
    })
    expect((row!.params as { items: unknown[] }).items).toHaveLength(2)
  })

  it('stages nothing while a batch waits, once today, or with nothing due', async () => {
    expect(await stage(world({ pending_operations: { data: [{ id: 'op-0', status: 'pending', params: {} }] } }))).toEqual({
      status: 'pending_exists',
      operationId: 'op-0',
      sent: 0,
    })
    // Nothing waits; today's batch was approved already.
    const approvedToday: TableMockResolver = (calls) =>
      calls.some((c) => c.method === 'in') ? { data: [] } : { data: [{ params: { batch_date: '2026-12-17' } }] }
    expect(await stage(world({ pending_operations: approvedToday }))).toEqual({
      status: 'already_staged',
      sent: 0,
    })
    expect(await stage(world({ invoices: { data: [] }, pending_operations: { data: [] } }))).toEqual({ status: 'empty', excluded: 0, sent: 0 })
  })

  it('needs an owner to stage under, and takes a racing run as already staged', async () => {
    expect(await stage(world({ pending_operations: { data: [] }, company_members: { data: [] } }))).toEqual({ status: 'no_owner', sent: 0 })
    const raced = world({ pending_operations: [{ data: [] }, { data: [] }, { data: null, error: { code: '23505', message: 'duplicate key' } }] })
    expect(await stage(raced)).toEqual({ status: 'already_staged', sent: 0 })
  })
})

describe('stageReminderBatch with automatic sending on', () => {
  const automatic = () => ({ actorUserId: 'admin-1', channel: createFakeReminderChannel(), log: { error: vi.fn() } as never, sendingEnabled: true })

  it('sends the reminders whose bank passed and stages only the uncertain ones', async () => {
    vi.mocked(dispatchReminder).mockResolvedValue({ status: 'sent', reminderId: 'rem-1', level: 1, providerMessageId: 'm', recorded: true })
    const mock = world({ pending_operations: [{ data: [] }, { data: [] }, { data: { id: 'op-1' } }] })

    const outcome = await stageReminderBatch(mock.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW, automatic: automatic() })

    expect(outcome).toEqual({ status: 'staged', operationId: 'op-1', items: 1, excluded: 2, sent: 1 })
    expect(vi.mocked(dispatchReminder).mock.calls.map(([, input]) => input)).toEqual([
      { companyId: COMPANY, invoiceId: ids.due, level: 1, actorUserId: 'admin-1', mode: 'automatic' },
    ])
    const [row] = mock.payloads('pending_operations', 'insert') as Array<{ params: { items: Array<{ invoice_id: string }> } }>
    expect(row!.params.items.map((item) => item.invoice_id)).toEqual([ids.stale])
  })

  it('still sends while yesterday\'s batch waits, and stages nothing beside it', async () => {
    vi.mocked(dispatchReminder).mockResolvedValue({ status: 'skipped', reason: 'already_sent' })
    const mock = world({ pending_operations: { data: [{ id: 'op-0', status: 'pending', params: { batch_date: '2026-12-16' } }] } })
    const outcome = await stageReminderBatch(mock.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW, automatic: automatic() })
    expect(outcome).toEqual({ status: 'pending_exists', operationId: 'op-0', sent: 0 })
    expect(dispatchReminder).toHaveBeenCalledTimes(1)
    expect(mock.payloads('pending_operations', 'insert')).toEqual([])
  })
})

describe('runReminderBatchCron', () => {
  it('reads nothing while sending is off', async () => {
    const mock = world()
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: false })
    expect(summary.enabled).toBe(false)
    expect(mock.tables()).toEqual([])
  })

  it('withdraws a batch past its three days, then stages per company with reminders on', async () => {
    const mock = createTableMockSupabase({
      company_settings: (calls) => {
        const selected = String(calls.find((c) => c.method === 'select')?.args[0] ?? '')
        if (selected.startsWith('reminder_days')) return { data: { reminder_days_level_1: 15, reminder_days_level_2: 30, reminder_days_level_3: 45 } }
        // The cron's company list, and the pending batch's company still has reminders on.
        return { data: [{ company_id: COMPANY }] }
      },
      invoices: { data: [{ id: ids.due }] },
      company_members: { data: [{ user_id: 'owner-1', role: 'owner' }] },
      pending_operations: (calls) => {
        if (calls.some((c) => c.method === 'update')) return { data: [{ id: 'old-op' }] }
        if (calls.some((c) => c.method === 'insert')) return { data: { id: 'op-new' } }
        // The stage step's lookups: nothing waits, nothing staged today.
        if (calls.some((c) => c.method === 'in' || c.method === 'gte')) return { data: [] }
        return { data: [{ id: 'old-op', company_id: COMPANY }] }
      },
    })
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true })
    expect(summary).toMatchObject({ enabled: true, companies: 1, staged: 1, failed: 0, withdrawn: 1 })
  })

  it("withdraws a pending batch of a company that turned reminders off", async () => {
    const mock = createTableMockSupabase({
      company_settings: { data: [] },
      pending_operations: (calls) => {
        const updated = calls.find((c) => c.method === 'update')?.args[0] as { result_data?: { reason?: string } } | undefined
        if (updated?.result_data?.reason === 'reminders_off') return { data: [{ id: 'op-off' }] }
        if (updated) return { data: [] }
        return { data: [{ id: 'op-off', company_id: 'company-off' }] }
      },
    })
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true })
    expect(summary).toMatchObject({ withdrawn: 1, companies: 0 })
    expect(mock.payloads('pending_operations', 'update')).toContainEqual(
      expect.objectContaining({ status: 'rejected', rejection_category: 'superseded', result_data: { auto_rejected: true, reason: 'reminders_off' } }),
    )
  })

  it('counts a company that fails and goes on', async () => {
    vi.mocked(loadReminderContext).mockRejectedValue(new Error('boom'))
    const mock = createTableMockSupabase({
      company_settings: (calls) =>
        String(calls.find((c) => c.method === 'select')?.args[0] ?? '').startsWith('reminder_days')
          ? { data: {} }
          : { data: [{ company_id: COMPANY }, { company_id: 'company-2' }] },
      invoices: { data: [{ id: ids.due }] },
      pending_operations: { data: [] },
    })
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true, log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } as never })
    expect(summary).toMatchObject({ companies: 2, failed: 2, staged: 0 })
  })
})
