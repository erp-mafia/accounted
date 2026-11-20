import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import type { ReminderContext } from '../facts'
import type { ReminderHistoryEntry, ReminderInvoiceFacts } from '../policy'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
const { loadReminderContext } = await import('../facts')
const { ladderFollows, loadInvoiceReminderLadder } = await import('../invoice-ladder')

const NOW = new Date('2026-12-17T11:00:00Z')
const TODAY = '2026-12-17'
const SCHEDULE = { days: [15, 30, 45] as const }
const ENABLED_AT = '2026-11-01T08:00:00Z'

function facts(overrides: Partial<ReminderInvoiceFacts> = {}): ReminderInvoiceFacts {
  return {
    kind: 'invoice',
    status: 'sent',
    invoiceDate: '2026-11-20',
    dueDate: '2026-12-20',
    remaining: 1000,
    credited: false,
    delivery: 'delivered',
    imported: false,
    autogiro: false,
    recipient: 'kund@example.se',
    customerExcluded: false,
    withCollections: false,
    ...overrides,
  }
}

const sent = (level: 1 | 2 | 3, sentOn: string): ReminderHistoryEntry => ({
  level,
  status: 'sent',
  sentOn,
  providerStatus: null,
  responseType: null,
  legacy: false,
})

const follows = (invoice: ReminderInvoiceFacts, history: ReminderHistoryEntry[] = [], enabledAt: string | null = ENABLED_AT) =>
  ladderFollows({ today: TODAY, schedule: SCHEDULE, enabledAt, invoice, history })

describe('ladderFollows', () => {
  it('follows an invoice of our own dated after the turn-on, before it is even due', () => {
    expect(follows(facts())).toBe(true)
  })

  it('follows an overdue invoice already on the ladder, whose next level waits for its day', () => {
    expect(follows(facts({ status: 'overdue', invoiceDate: '2026-10-01', dueDate: '2026-11-01' }), [sent(1, '2026-11-16')])).toBe(true)
  })

  it('does not follow what the policy leaves to a person or stops', () => {
    expect(follows(facts({ invoiceDate: '2026-10-20' }))).toBe(false) // dated before the turn-on
    expect(follows(facts({ imported: true }))).toBe(false)
    expect(follows(facts({ delivery: 'no_history' }))).toBe(false) // registered, never sent from Accounted
    expect(follows(facts({ delivery: 'not_delivered' }))).toBe(false)
    expect(follows(facts({ customerExcluded: true }))).toBe(false)
    expect(follows(facts({ recipient: null }))).toBe(false)
    expect(follows(facts({ withCollections: true }))).toBe(false)
    expect(follows(facts({ remaining: 0 }))).toBe(false)
    expect(follows(facts(), [], null)).toBe(false)
  })

  it('does not follow an invoice that has had all three reminders', () => {
    const invoice = facts({ status: 'overdue', invoiceDate: '2026-09-01', dueDate: '2026-10-01' })
    expect(follows(invoice, [sent(1, '2026-10-16'), sent(2, '2026-10-31'), sent(3, '2026-11-15')])).toBe(false)
  })
})

describe('loadInvoiceReminderLadder', () => {
  function context(overrides: Partial<ReminderContext> = {}): ReminderContext {
    return {
      invoice: makeInvoice({ id: 'inv-1' }),
      customer: makeCustomer(),
      company: makeCompanySettings({
        send_invoice_reminders: true,
        reminders_enabled_at: ENABLED_AT,
        reminder_days_level_1: 10,
        reminder_days_level_2: 20,
        reminder_days_level_3: 30,
      }),
      companyInactive: false,
      amount: 1000,
      facts: facts(),
      history: [],
      ...overrides,
    }
  }
  const db = {} as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("answers the company's days and that the ladder follows the invoice", async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(context())
    expect(await loadInvoiceReminderLadder(db, 'company-1', 'inv-1', { now: NOW, sendingEnabled: true })).toEqual({
      on: true,
      follows: true,
      days: [10, 20, 30],
    })
    expect(loadReminderContext).toHaveBeenCalledWith(db, 'company-1', 'inv-1')
  })

  it('follows nothing while reminders are off, product-wide or for the company, or for an inactive company', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(context())
    expect(await loadInvoiceReminderLadder(db, 'company-1', 'inv-1', { now: NOW, sendingEnabled: false })).toMatchObject({ on: false, follows: false })

    vi.mocked(loadReminderContext).mockResolvedValue(context({ company: makeCompanySettings({ send_invoice_reminders: false }) }))
    expect(await loadInvoiceReminderLadder(db, 'company-1', 'inv-1', { now: NOW, sendingEnabled: true })).toMatchObject({ on: false, follows: false })

    vi.mocked(loadReminderContext).mockResolvedValue(context({ companyInactive: true }))
    expect(await loadInvoiceReminderLadder(db, 'company-1', 'inv-1', { now: NOW, sendingEnabled: true })).toMatchObject({ on: true, follows: false })
  })
})
