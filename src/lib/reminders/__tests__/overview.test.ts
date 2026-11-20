import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { ReminderContext } from '../facts'
import type { ReminderInvoiceFacts } from '../policy'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
const { loadReminderContext } = await import('../facts')
const { loadReminderOverview, loadReminderSummary } = await import('../overview')

const NOW = new Date('2026-12-17T11:00:00Z')

function context(id: string, facts: Partial<ReminderInvoiceFacts> = {}): ReminderContext {
  return {
    invoice: makeInvoice({ id, invoice_number: `F-${id}`, invoice_date: '2026-10-01', due_date: '2026-11-01', currency: 'SEK' }),
    customer: makeCustomer({ name: 'Kund AB' }),
    company: makeCompanySettings(),
    companyInactive: false,
    amount: 1000,
    facts: {
      kind: 'invoice',
      status: 'overdue',
      invoiceDate: '2026-10-01',
      dueDate: '2026-11-01',
      remaining: 1000,
      credited: false,
      delivery: 'delivered',
      imported: false,
      autogiro: false,
      recipient: 'kund@example.se',
      customerExcluded: false,
      withCollections: false,
      ...facts,
    },
    history: [],
  }
}

const CONTEXTS: Record<string, ReminderContext> = {
  own: context('own'),
  imported: context('imported', { imported: true }),
  addressless: context('addressless', { recipient: null }),
  excluded: context('excluded', { customerExcluded: true }),
}

function db(overrides: Parameters<typeof createTableMockSupabase>[0] = {}) {
  return createTableMockSupabase({
    company_settings: { data: { send_invoice_reminders: false, reminders_enabled_at: null, reminder_days_level_1: 10, reminder_days_level_2: 20, reminder_days_level_3: 30 } },
    collection_connections: { data: [] },
    invoices: { data: Object.keys(CONTEXTS).map((id) => ({ id })), count: 4 },
    ...overrides,
  }).supabase as unknown as SupabaseClient
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => CONTEXTS[id]!)
})

describe('loadReminderOverview', () => {
  it("offers only the company's own delivered overdue invoices with an address, to pick once", async () => {
    const overview = await loadReminderOverview(db(), 'company-1', { now: NOW, sendingEnabled: true })
    expect(overview).toMatchObject({
      available: true,
      enabled: false,
      enabledAt: null,
      schedule: { days: [10, 20, 30] },
      collectionsConnected: false,
      overdueCount: 4,
      pickableTruncated: false,
      offerableCount: 1,
      automatic: { on: false, since: null, eligible: false, cleanStreak: 0 },
    })
    expect(overview.pickable).toEqual([
      {
        invoice_id: 'own',
        invoice_number: 'F-own',
        customer_name: 'Kund AB',
        recipient: 'kund@example.se',
        due_date: '2026-11-01',
        overdue_days: 46,
        remaining_amount: 1000,
        currency: 'SEK',
      },
    ])
  })

  it('offers nothing while the product switch is off or a collections provider reminds', async () => {
    expect((await loadReminderOverview(db(), 'company-1', { now: NOW, sendingEnabled: false })).pickable).toEqual([])
    const connected = await loadReminderOverview(db({ collection_connections: { data: [{ id: 'conn-1' }] } }), 'company-1', { now: NOW, sendingEnabled: true })
    expect(connected).toMatchObject({ collectionsConnected: true, pickable: [] })
    expect(loadReminderContext).not.toHaveBeenCalled()
  })

  it('counts and offers what the one overdue rule counts: never a sent credit note or a proforma (crm#1435)', async () => {
    const mock = createTableMockSupabase({
      company_settings: { data: { send_invoice_reminders: false, reminders_enabled_at: null, reminder_days_level_1: 10, reminder_days_level_2: 20, reminder_days_level_3: 30 } },
      collection_connections: { data: [] },
      invoices: { data: [{ id: 'own' }], count: 1 },
    })
    await loadReminderOverview(mock.supabase as unknown as SupabaseClient, 'company-1', { now: NOW, sendingEnabled: true })
    // The overdue list is the first invoices query (filterOverdueInvoices, lib/invoices/overdue.ts).
    expect(mock.findCall('invoices', 'select')).toEqual(['id', { count: 'exact' }])
    expect(mock.findCalls('invoices', 'is')[0]).toEqual(['credited_invoice_id', null])
    expect(mock.payloads('invoices', 'eq').slice(0, 2)).toEqual(['company_id', 'document_type'])
    expect(mock.findCalls('invoices', 'gt')[0]).toEqual(['remaining_amount', 0])
    expect(mock.findCalls('invoices', 'lt')[0]).toEqual(['due_date', '2026-12-17'])
  })

  it('says when there were more overdue invoices than it looked at', async () => {
    const overview = await loadReminderOverview(db({ invoices: { data: [{ id: 'own' }], count: 250 } }), 'company-1', { now: NOW, sendingEnabled: true })
    expect(overview).toMatchObject({ overdueCount: 250, pickableTruncated: true })
  })

  it("decides the pick list from the ladder's own start while reminders are on", async () => {
    // Dated after the turn-on: the ladder follows it (level 1 due 2026-12-20), so a pick would send it early.
    const inLadder = context('in-ladder', { invoiceDate: '2026-12-05', dueDate: '2026-12-10' })
    vi.mocked(loadReminderContext).mockImplementation(async (_db, _company, id) => (id === 'in-ladder' ? inLadder : CONTEXTS[id]!))
    const invoices = { data: [{ id: 'own' }, { id: 'in-ladder' }], count: 2 }
    const on = db({
      company_settings: { data: { send_invoice_reminders: true, reminders_enabled_at: '2026-12-01T08:00:00Z', reminder_days_level_1: 10, reminder_days_level_2: 20, reminder_days_level_3: 30 } },
      invoices,
    })
    const enabled = await loadReminderOverview(on, 'company-1', { now: NOW, sendingEnabled: true })
    expect(enabled.pickable.map((p) => p.invoice_id)).toEqual(['own'])
    expect(enabled.offerableCount).toBe(1)

    // Off, the same invoice is older than a turn-on now: it may be picked.
    const off = await loadReminderOverview(db({ invoices }), 'company-1', { now: NOW, sendingEnabled: true })
    expect(off.pickable.map((p) => p.invoice_id).sort()).toEqual(['in-ladder', 'own'])
  })

  it('reads reminders as on only with the product switch', async () => {
    const on = db({ company_settings: { data: { send_invoice_reminders: true, reminders_enabled_at: '2026-12-01T08:00:00Z' } } })
    expect(await loadReminderOverview(on, 'company-1', { now: NOW, sendingEnabled: true })).toMatchObject({ enabled: true, enabledAt: '2026-12-01T08:00:00Z' })
    expect(await loadReminderOverview(on, 'company-1', { now: NOW, sendingEnabled: false })).toMatchObject({ enabled: false, available: false })
  })
})

describe('loadReminderSummary', () => {
  function summaryDb(overrides: Parameters<typeof createTableMockSupabase>[0] = {}) {
    return createTableMockSupabase({
      company_settings: { data: { send_invoice_reminders: false, reminders_enabled_at: null } },
      collection_connections: { data: [] },
      invoices: { data: null, count: 7 },
      ...overrides,
    })
  }

  it('counts the invoices the sheet could offer in one query, without deciding any', async () => {
    const mock = summaryDb()
    const summary = await loadReminderSummary(mock.supabase as unknown as SupabaseClient, 'company-1', { now: NOW, sendingEnabled: true })
    expect(summary).toEqual({ available: true, enabled: false, enabledAt: null, collectionsConnected: false, offerableCount: 7 })
    expect(loadReminderContext).not.toHaveBeenCalled()
    // A head count over the owed invoices of our own, sent from Accounted to a customer with an address.
    expect(mock.findCall('invoices', 'select')).toEqual([
      'id, customer:customers!inner(email, reminders_excluded), invoice_deliveries!inner(status)',
      { count: 'exact', head: true },
    ])
    expect(mock.findCalls('invoices', 'in')).toEqual([
      ['status', ['sent', 'overdue', 'partially_paid']],
      ['invoice_deliveries.status', ['sent', 'marked_sent']],
    ])
    expect(mock.findCall('invoices', 'lt')).toEqual(['due_date', '2026-12-17'])
    expect(mock.findCall('invoices', 'not')).toEqual(['customer.email', 'is', null])
    expect(mock.findCall('invoices', 'eq')).toEqual(['company_id', 'company-1'])
    expect(mock.payloads('invoices', 'eq')).toEqual(['company_id', 'document_type', 'is_self_billed', 'customer.reminders_excluded'])
  })

  it('asks no count where the offer cannot show: reminders on, a collections provider, the product switch off', async () => {
    const on = summaryDb({ company_settings: { data: { send_invoice_reminders: true, reminders_enabled_at: '2026-12-01T08:00:00Z' } } })
    expect(await loadReminderSummary(on.supabase as unknown as SupabaseClient, 'company-1', { now: NOW, sendingEnabled: true })).toMatchObject({
      enabled: true,
      enabledAt: '2026-12-01T08:00:00Z',
      offerableCount: 0,
    })
    expect(on.findCall('invoices', 'select')).toBeUndefined()

    const connected = summaryDb({ collection_connections: { data: [{ id: 'conn-1' }] } })
    expect(await loadReminderSummary(connected.supabase as unknown as SupabaseClient, 'company-1', { now: NOW, sendingEnabled: true })).toMatchObject({
      collectionsConnected: true,
      offerableCount: 0,
    })
    expect(connected.findCall('invoices', 'select')).toBeUndefined()

    const dark = summaryDb()
    expect(await loadReminderSummary(dark.supabase as unknown as SupabaseClient, 'company-1', { now: NOW, sendingEnabled: false })).toMatchObject({
      available: false,
      offerableCount: 0,
    })
    expect(dark.findCall('invoices', 'select')).toBeUndefined()
  })

  it('fails when the count fails, rather than offer a wrong number', async () => {
    const broken = summaryDb({ invoices: { data: null, error: { message: 'boom' } } })
    await expect(loadReminderSummary(broken.supabase as unknown as SupabaseClient, 'company-1', { now: NOW, sendingEnabled: true })).rejects.toThrow(/offerable invoices count failed/)
  })
})
