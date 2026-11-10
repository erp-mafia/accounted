import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeCompanySettings, makeCustomer, makeInvoice, type TableMockResolver } from '@/tests/helpers'
import type { BankCheckResult } from '@/lib/collections/bank-check'
import { runWithTrace } from '@/lib/observability/trace-context-node'
import type { ReminderContext } from '../facts'
import type { ReminderHistoryEntry, ReminderInvoiceFacts } from '../policy'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
vi.mock('../bank', () => ({ checkReminderBank: vi.fn() }))
vi.mock('../dispatch', () => ({ dispatchReminder: vi.fn() }))
vi.mock('@/lib/entitlements/has-capability', () => ({ hasCapability: vi.fn() }))

const { loadReminderContext } = await import('../facts')
const { checkReminderBank } = await import('../bank')
const { dispatchReminder } = await import('../dispatch')
const { hasCapability } = await import('@/lib/entitlements/has-capability')
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

const SETTINGS = { reminder_days_level_1: 15, reminder_days_level_2: 30, reminder_days_level_3: 45, reminders_enabled_at: '2026-11-01T09:00:00Z' }
const CANDIDATES = 'rpc:list_reminder_candidate_invoices'
const COMPANIES = 'rpc:list_reminder_batch_companies'
const SWEEP = 'rpc:sweep_interrupted_invoice_reminders'

function world(overrides: Parameters<typeof createTableMockSupabase>[0] = {}) {
  return createTableMockSupabase({
    company_settings: { data: SETTINGS },
    [CANDIDATES]: { data: Object.keys(CONTEXTS).map((id) => ({ id })) },
    company_members: { data: [{ user_id: 'owner-1', role: 'owner' }] },
    ...overrides,
  })
}

/** A company the daily run visits (list_reminder_batch_companies). */
function company(id: string, automatic: { by?: string; admin?: boolean } = {}) {
  return {
    company_id: id,
    reminders_automatic_at: automatic.by ? '2026-12-10T08:00:00Z' : null,
    reminders_automatic_by: automatic.by ?? null,
    automatic_by_admin: automatic.admin ?? automatic.by !== undefined,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => CONTEXTS[id]!)
  vi.mocked(checkReminderBank).mockImplementation(async (_db, ctx) =>
    bank(ctx.invoice.id === ids.stale ? 'stale' : ctx.invoice.id === ids.paid ? 'candidates' : 'pass'),
  )
  vi.mocked(hasCapability).mockResolvedValue(true)
})

describe('gatherReminderBatch', () => {
  it('stages the due reminders, marks an unchecked bank, and lists what a person should see', async () => {
    const { supabase, findCall } = world()
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
    // Only invoices past the first level's days are read (due on or before
    // 2026-12-02), dated since the turn-on day in Stockholm or already
    // holding a reminder row (the function's rule).
    expect(findCall(CANDIDATES, 'rpc')).toEqual([{ p_company_id: COMPANY, p_due_on_or_before: '2026-12-02', p_enabled_on: '2026-11-01' }])
    // The bank is asked only for reminders that are due.
    expect(checkReminderBank).toHaveBeenCalledTimes(3)
    expect(batch.automaticInvoiceIds).toEqual([ids.due, ids.stale])
  })

  it('reads the turn-on day in Stockholm, and only invoices on the ladder while reminders are off', async () => {
    const late = world({ company_settings: { data: { ...SETTINGS, reminders_enabled_at: '2026-10-31T23:30:00Z' } } })
    await gatherReminderBatch(late.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })
    expect(late.findCall(CANDIDATES, 'rpc')).toEqual([expect.objectContaining({ p_enabled_on: '2026-11-01' })])

    const off = world({ company_settings: { data: { ...SETTINGS, reminders_enabled_at: null } } })
    await gatherReminderBatch(off.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })
    expect(off.findCall(CANDIDATES, 'rpc')).toEqual([expect.objectContaining({ p_enabled_on: null })])
  })

  it('leaves an invoice not issued and delivered from Accounted out of the automatic ones', async () => {
    vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) =>
      id === ids.due ? context(ids.due, { imported: true }, [{ level: 1, status: 'sent', sentOn: '2026-12-17', providerStatus: 'delivered', responseType: null, legacy: false }]) : CONTEXTS[id]!,
    )
    const batch = await gatherReminderBatch(world({ [CANDIDATES]: { data: [{ id: ids.due }] } }).supabase as unknown as SupabaseClient, {
      companyId: COMPANY,
      now: new Date('2027-01-02T11:00:00Z'),
    })
    expect(batch.items.map((item) => [item.invoice_id, item.level])).toEqual([[ids.due, 2]])
    expect(batch.automaticInvoiceIds).toEqual([])
  })

  it('reminds nobody for an archived, reset or sandbox company', async () => {
    vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => ({ ...CONTEXTS[id]!, companyInactive: true }))
    const batch = await gatherReminderBatch(world().supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })
    expect(batch).toEqual({ batchDate: '2026-12-17', items: [], excluded: [], automaticInvoiceIds: [] })
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
    // Outside a request scope: no trace, and the row does not name the column.
    expect(row).not.toHaveProperty('trace_id')
    expect((row!.params as { items: unknown[] }).items).toHaveLength(2)
  })

  it('stamps the trace id of the run that staged the batch', async () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736'
    const mock = world({ pending_operations: [{ data: [] }, { data: [] }, { data: { id: 'op-1' } }] })
    await runWithTrace(traceId, () => stage(mock))
    const [row] = mock.payloads('pending_operations', 'insert') as Array<Record<string, unknown>>
    expect(row).toMatchObject({ operation_type: 'reminder_daily_batch', trace_id: traceId })
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
    expect(await stage(world({ [CANDIDATES]: { data: [] }, pending_operations: { data: [] } }))).toEqual({ status: 'empty', excluded: 0, sent: 0 })
  })

  it('needs an owner to stage under, and takes a racing run as already staged', async () => {
    expect(await stage(world({ pending_operations: { data: [] }, company_members: { data: [] } }))).toEqual({ status: 'no_owner', sent: 0 })
    const raced = world({ pending_operations: [{ data: [] }, { data: [] }, { data: null, error: { code: '23505', message: 'duplicate key' } }] })
    expect(await stage(raced)).toEqual({ status: 'already_staged', sent: 0 })
  })
})

describe('stageReminderBatch: a reminder nobody knows went out', () => {
  const stage = (mock: ReturnType<typeof world>) => stageReminderBatch(mock.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW })
  const failedUnknown = { level: 1 as const, status: 'failed' as const, sentOn: null, providerStatus: null, responseType: null, legacy: false, outcomeUnknown: true }
  // Nothing due today; one invoice whose level 1 failed with an unknown outcome.
  const onlyFailed = () =>
    vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => context(id, {}, [failedUnknown]))

  it('stages a batch that only lists it, on a day with nothing due, when it failed since the last run', async () => {
    onlyFailed()
    const mock = world({
      [CANDIDATES]: { data: [{ id: ids.due }] },
      invoice_reminders: { data: [{ invoice_id: ids.due }] },
      pending_operations: [{ data: [] }, { data: [] }, { data: { id: 'op-list' } }],
    })
    expect(await stage(mock)).toEqual({ status: 'staged', operationId: 'op-list', items: 0, excluded: 1, sent: 0 })
    const [row] = mock.payloads('pending_operations', 'insert') as Array<{ title: string; params: { items: unknown[]; excluded: Array<{ reason: string }> } }>
    expect(row!.title).toBe('Påminnelser 2026-12-17: 1 påminnelse att kontrollera')
    expect(row!.params.items).toEqual([])
    expect(row!.params.excluded).toEqual([expect.objectContaining({ invoice_id: ids.due, reason: 'send_failed' })])
    // Failed since the last run: within the last 26 hours.
    expect(mock.findCalls('invoice_reminders', 'gte')).toEqual([['failed_at', '2026-12-16T09:00:00.000Z']])
  })

  it('stages nothing for a failure an earlier batch showed, or while a batch that lists waits', async () => {
    onlyFailed()
    const seen = world({ [CANDIDATES]: { data: [{ id: ids.due }] }, invoice_reminders: { data: [] }, pending_operations: { data: [] } })
    expect(await stage(seen)).toEqual({ status: 'empty', excluded: 1, sent: 0 })

    const waiting = world({
      [CANDIDATES]: { data: [{ id: ids.due }] },
      invoice_reminders: { data: [{ invoice_id: ids.due }] },
      pending_operations: { data: [{ id: 'op-list', status: 'pending', item_count: 0, params: { batch_date: '2026-12-16' } }] },
    })
    expect(await stage(waiting)).toEqual({ status: 'pending_exists', operationId: 'op-list', sent: 0 })
    expect(waiting.payloads('pending_operations', 'insert')).toEqual([])
  })

  it('replaces a waiting batch that only lists with a batch that has reminders', async () => {
    const mock = world({
      pending_operations: (calls) => {
        if (calls.some((c) => c.method === 'insert')) return { data: { id: 'op-new' } }
        if (calls.some((c) => c.method === 'update')) return { data: null }
        if (calls.some((c) => c.method === 'in')) return { data: [{ id: 'op-list', status: 'pending', item_count: 0 }] }
        return { data: [{ params: { batch_date: '2026-12-16' } }] }
      },
    })
    expect(await stage(mock)).toEqual({ status: 'staged', operationId: 'op-new', items: 2, excluded: 2, sent: 0 })
    expect(mock.payloads('pending_operations', 'update')).toEqual([
      expect.objectContaining({ status: 'rejected', rejection_category: 'superseded', result_data: { auto_rejected: true, reason: 'superseded' } }),
    ])
    expect(mock.findCalls('pending_operations', 'eq')).toEqual(expect.arrayContaining([['id', 'op-list'], ['status', 'pending']]))
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

  it('sends only invoices issued and delivered from Accounted; any other waits for a person', async () => {
    vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => (id === ids.due ? context(ids.due, { delivery: 'not_delivered' }, [
      { level: 1, status: 'sent', sentOn: '2026-12-17', providerStatus: 'delivered', responseType: null, legacy: false },
    ]) : CONTEXTS[id]!))
    const mock = world({ pending_operations: [{ data: [] }, { data: [] }, { data: { id: 'op-1' } }] })
    const outcome = await stageReminderBatch(mock.supabase as unknown as SupabaseClient, {
      companyId: COMPANY,
      now: new Date('2027-01-02T11:00:00Z'),
      automatic: automatic(),
    })
    expect(dispatchReminder).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({ status: 'staged', sent: 0 })
    const [row] = mock.payloads('pending_operations', 'insert') as Array<{ params: { items: Array<{ invoice_id: string; level: number }> } }>
    expect(row!.params.items).toContainEqual(expect.objectContaining({ invoice_id: ids.due, level: 2 }))
  })

  it('stages an item dispatch left for a person', async () => {
    vi.mocked(dispatchReminder).mockResolvedValue({ status: 'skipped', reason: 'needs_person' })
    const mock = world({ pending_operations: [{ data: [] }, { data: [] }, { data: { id: 'op-1' } }] })
    const outcome = await stageReminderBatch(mock.supabase as unknown as SupabaseClient, { companyId: COMPANY, now: NOW, automatic: automatic() })
    expect(outcome).toEqual({ status: 'staged', operationId: 'op-1', items: 2, excluded: 2, sent: 0 })
  })
})

describe('runReminderBatchCron', () => {
  const quiet = () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn() })

  it('reads nothing while sending is off', async () => {
    const mock = world()
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: false })
    expect(summary.enabled).toBe(false)
    expect(mock.tables()).toEqual([])
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('sweeps interrupted sends, withdraws a batch past its three days, then stages per company the run visits', async () => {
    const mock = createTableMockSupabase({
      [SWEEP]: { data: [{ company_id: 'company-9', swept: 2 }] },
      [COMPANIES]: { data: [company(COMPANY)] },
      company_settings: (calls) => {
        const selected = String(calls.find((c) => c.method === 'select')?.args[0] ?? '')
        if (selected.startsWith('reminder_days')) return { data: SETTINGS }
        // The pending batch's company still has reminders on.
        return { data: [{ company_id: COMPANY }] }
      },
      [CANDIDATES]: { data: [{ id: ids.due }] },
      company_members: { data: [{ user_id: 'owner-1', role: 'owner' }] },
      pending_operations: (calls) => {
        if (calls.some((c) => c.method === 'update')) return { data: [{ id: 'old-op' }] }
        if (calls.some((c) => c.method === 'insert')) return { data: { id: 'op-new' } }
        // The stage step's lookups: nothing waits, nothing staged today.
        if (calls.some((c) => c.method === 'in' || c.method === 'gte')) return { data: [] }
        return { data: [{ id: 'old-op', company_id: COMPANY }] }
      },
    })
    const log = quiet()
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true, log: log as never })
    expect(summary).toMatchObject({ enabled: true, companies: 1, staged: 1, failed: 0, withdrawn: 1, swept: 2 })
    // Reserved for 15 minutes or more.
    expect(mock.findCall(SWEEP, 'rpc')).toEqual([{ p_reserved_before: '2026-12-17T10:45:00.000Z' }])
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('outcome unknown'), { companyId: 'company-9', swept: 2 })
    // The sweep runs before any batch is gathered, so today's batches list what it swept.
    const order = mock.calls.map((c) => c.table)
    expect(order.indexOf(SWEEP)).toBeLessThan(order.indexOf(CANDIDATES))
  })

  it('goes on when the sweep or the withdrawal of turned-off companies fails', async () => {
    const mock = createTableMockSupabase({
      [SWEEP]: { data: null, error: { message: 'statement timeout' } },
      [COMPANIES]: { data: [company(COMPANY)] },
      company_settings: { data: SETTINGS },
      [CANDIDATES]: { data: [{ id: ids.due }] },
      company_members: { data: [{ user_id: 'owner-1', role: 'owner' }] },
      pending_operations: (calls) => {
        if (calls.some((c) => c.method === 'insert')) return { data: { id: 'op-new' } }
        if (calls.some((c) => c.method === 'update')) return { data: [] }
        if (calls.some((c) => c.method === 'in' || c.method === 'gte')) return { data: [] }
        // The withdrawal's read of every pending batch.
        return { data: null, error: { message: 'connection reset' } }
      },
    })
    const log = quiet()
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true, log: log as never })
    expect(summary).toMatchObject({ swept: 0, staged: 1, failed: 0 })
    expect(log.error).toHaveBeenCalledWith('interrupted reminders not swept', expect.any(Error))
    expect(log.error).toHaveBeenCalledWith('reminder batches of companies that turned reminders off not withdrawn', expect.any(Error))
  })

  it("withdraws a pending batch of a company that turned reminders off, in chunks", async () => {
    const pending = Array.from({ length: 250 }, (_, i) => ({ id: `op-${i}`, company_id: `company-off-${i}` }))
    const mock = createTableMockSupabase({
      company_settings: { data: [] },
      pending_operations: (calls) => {
        const updated = calls.find((c) => c.method === 'update')?.args[0] as { result_data?: { reason?: string } } | undefined
        if (updated?.result_data?.reason === 'reminders_off') {
          const ids = calls.find((c) => c.method === 'in')?.args[1] as string[]
          return { data: ids.map((id) => ({ id })) }
        }
        if (updated) return { data: [] }
        return { data: pending }
      },
    })
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true })
    expect(summary).toMatchObject({ withdrawn: 250, companies: 0 })
    expect(mock.findCalls('company_settings', 'in').map(([, values]) => (values as string[]).length)).toEqual([200, 50])
    expect(mock.payloads('pending_operations', 'update')).toContainEqual(
      expect.objectContaining({ status: 'rejected', rejection_category: 'superseded', result_data: { auto_rejected: true, reason: 'reminders_off' } }),
    )
  })

  describe('automatic sending', () => {
    function automaticWorld() {
      return createTableMockSupabase({
        company_settings: { data: SETTINGS },
        [CANDIDATES]: { data: [{ id: ids.due }] },
        company_members: { data: [{ user_id: 'owner-1', role: 'owner' }] },
        pending_operations: (calls) => (calls.some((c) => c.method === 'insert') ? { data: { id: 'op-new' } } : { data: [] }),
      })
    }
    const run = (mock: ReturnType<typeof automaticWorld>, log = quiet()) =>
      runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true, channel: createFakeReminderChannel(), log: log as never })

    it('sends for a company whose automatic sending an owner or administrator turned on', async () => {
      vi.mocked(dispatchReminder).mockResolvedValue({ status: 'sent', reminderId: 'rem-1', level: 1, providerMessageId: 'm', recorded: true })
      const mock = automaticWorld()
      mock.setTable(COMPANIES, { data: [company(COMPANY, { by: 'admin-1' })] })
      expect(await run(mock)).toMatchObject({ sentAutomatically: 1, automaticHeld: 0 })
      expect(hasCapability).toHaveBeenCalledWith(mock.supabase, COMPANY, 'email_send')
      expect(dispatchReminder).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ actorUserId: 'admin-1', mode: 'automatic' }))
    })

    it('waits for approval when that person is no longer an owner or administrator', async () => {
      const mock = automaticWorld()
      mock.setTable(COMPANIES, { data: [company(COMPANY, { by: 'former-admin', admin: false })] })
      const log = quiet()
      expect(await run(mock, log)).toMatchObject({ sentAutomatically: 0, automaticHeld: 1, staged: 1 })
      expect(dispatchReminder).not.toHaveBeenCalled()
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no longer an owner or administrator'), { companyId: COMPANY, automaticBy: 'former-admin' })
    })

    it('waits for approval when the company cannot send email', async () => {
      vi.mocked(hasCapability).mockResolvedValue(false)
      const mock = automaticWorld()
      mock.setTable(COMPANIES, { data: [company(COMPANY, { by: 'admin-1' })] })
      expect(await run(mock)).toMatchObject({ sentAutomatically: 0, automaticHeld: 1, staged: 1 })
      expect(dispatchReminder).not.toHaveBeenCalled()
    })
  })

  it('counts a company that fails and goes on', async () => {
    vi.mocked(loadReminderContext).mockRejectedValue(new Error('boom'))
    const mock = createTableMockSupabase({
      [COMPANIES]: { data: [company(COMPANY), company('company-2')] },
      company_settings: { data: {} },
      [CANDIDATES]: { data: [{ id: ids.due }] },
      pending_operations: { data: [] },
    })
    const summary = await runReminderBatchCron({ db: mock.supabase as unknown as SupabaseClient, now: () => NOW, sendingEnabled: true, log: quiet() as never })
    expect(summary).toMatchObject({ companies: 2, failed: 2, staged: 0 })
  })
})
