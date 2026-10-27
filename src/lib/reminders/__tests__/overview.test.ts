import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { ReminderContext } from '../facts'
import type { ReminderInvoiceFacts } from '../policy'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
const { loadReminderContext } = await import('../facts')
const { loadReminderOverview } = await import('../overview')

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

  it('says when there were more overdue invoices than it looked at', async () => {
    const overview = await loadReminderOverview(db({ invoices: { data: [{ id: 'own' }], count: 250 } }), 'company-1', { now: NOW, sendingEnabled: true })
    expect(overview).toMatchObject({ overdueCount: 250, pickableTruncated: true })
  })

  it('reads reminders as on only with the product switch', async () => {
    const on = db({ company_settings: { data: { send_invoice_reminders: true, reminders_enabled_at: '2026-12-01T08:00:00Z' } } })
    expect(await loadReminderOverview(on, 'company-1', { now: NOW, sendingEnabled: true })).toMatchObject({ enabled: true, enabledAt: '2026-12-01T08:00:00Z' })
    expect(await loadReminderOverview(on, 'company-1', { now: NOW, sendingEnabled: false })).toMatchObject({ enabled: false, available: false })
  })
})
