import { describe, it, expect } from 'vitest'
import {
  decideReminder,
  DEFAULT_REMINDER_DAYS,
  reminderSchedule,
  sendsAutomatically,
  type ReminderDecisionInput,
  type ReminderHistoryEntry,
  type ReminderInvoiceFacts,
} from '../policy'

const SCHEDULE = reminderSchedule({ reminder_days_level_1: 15, reminder_days_level_2: 30, reminder_days_level_3: 45 })
// Reminders went on 2026-11-01 (Stockholm); the invoice is dated after it.
const ENABLED_AT = '2026-11-01T09:00:00Z'

function invoice(overrides: Partial<ReminderInvoiceFacts> = {}): ReminderInvoiceFacts {
  return {
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
    ...overrides,
  }
}

function sent(level: 1 | 2 | 3, sentOn: string, overrides: Partial<ReminderHistoryEntry> = {}): ReminderHistoryEntry {
  return { level, status: 'sent', sentOn, providerStatus: null, responseType: null, legacy: false, ...overrides }
}

function decide(overrides: Partial<ReminderDecisionInput> = {}) {
  return decideReminder({
    today: '2026-12-17',
    schedule: SCHEDULE,
    enabledAt: ENABLED_AT,
    invoice: invoice(),
    history: [],
    ...overrides,
  })
}

describe('decideReminder: the ladder', () => {
  it('sends level 1 on the day it falls due, never before', () => {
    expect(decide({ today: '2026-12-16' })).toEqual({ kind: 'skip', reason: 'not_due', nextOn: '2026-12-17' })
    expect(decide({ today: '2026-12-17' })).toEqual({ kind: 'remind', level: 1 })
  })

  it('takes one level at a time, each after its day and its gap since the previous reminder', () => {
    // Level 1 went out late (2027-01-20): level 2 waits 15 days from it, not
    // for due + 30, which has passed.
    const history = [sent(1, '2027-01-20')]
    expect(decide({ today: '2027-01-21', history })).toEqual({ kind: 'skip', reason: 'not_due', nextOn: '2027-02-04' })
    expect(decide({ today: '2027-02-04', history })).toEqual({ kind: 'remind', level: 2 })
    // On time: level 2 on due + 30.
    expect(decide({ today: '2027-01-01', history: [sent(1, '2026-12-17')] })).toEqual({ kind: 'remind', level: 2 })
  })

  it('ends after level 3', () => {
    const history = [sent(1, '2026-12-17'), sent(2, '2027-01-01'), sent(3, '2027-01-16')]
    expect(decide({ today: '2027-06-01', history })).toEqual({ kind: 'skip', reason: 'complete' })
  })

  it('starts at level 1 however long overdue', () => {
    expect(decide({ today: '2027-09-01' })).toEqual({ kind: 'remind', level: 1 })
  })
})

describe('decideReminder: who joins the ladder by itself', () => {
  it('only an invoice dated on or after the day reminders went on', () => {
    expect(decide({ invoice: invoice({ invoiceDate: '2026-10-31' }) })).toEqual({ kind: 'skip', reason: 'before_enabled' })
    expect(decide({ invoice: invoice({ invoiceDate: '2026-11-01' }) })).toEqual({ kind: 'remind', level: 1 })
    expect(decide({ enabledAt: null })).toEqual({ kind: 'skip', reason: 'before_enabled' })
  })

  it('never an imported invoice, one with no delivery history, or one that did not reach the customer', () => {
    expect(decide({ invoice: invoice({ imported: true }) })).toEqual({ kind: 'skip', reason: 'imported' })
    expect(decide({ invoice: invoice({ delivery: 'no_history' }) })).toEqual({ kind: 'skip', reason: 'imported' })
    expect(decide({ invoice: invoice({ delivery: 'not_delivered' }) })).toEqual({ kind: 'skip', reason: 'not_delivered' })
  })

  it('a picked invoice gets level 1 now, and the ladder from then on', () => {
    const old = invoice({ invoiceDate: '2026-03-01', dueDate: '2026-03-31', imported: true })
    expect(decide({ invoice: old, picked: true, today: '2026-11-10' })).toEqual({ kind: 'remind', level: 1 })
    // The daily run continues it after the gap, though it is imported.
    const history = [sent(1, '2026-11-10')]
    expect(decide({ invoice: old, history, today: '2026-11-24' })).toEqual({ kind: 'skip', reason: 'not_due', nextOn: '2026-11-25' })
    expect(decide({ invoice: old, history, today: '2026-11-25' })).toEqual({ kind: 'remind', level: 2 })
    // Picking again does not skip the gap.
    expect(decide({ invoice: old, history, today: '2026-11-11', picked: true })).toMatchObject({ reason: 'not_due' })
  })

  it('leaves an invoice the old sender reminded to a person', () => {
    expect(decide({ history: [sent(1, '2026-05-21', { legacy: true })] })).toEqual({ kind: 'skip', reason: 'earlier_reminders' })
    expect(decide({ history: [sent(2, '2026-05-21', { legacy: true })], picked: true })).toEqual({
      kind: 'skip',
      reason: 'earlier_reminders',
    })
  })
})

describe('decideReminder: stops', () => {
  it.each([
    [{ kind: 'other' as const }, 'not_invoice'],
    [{ credited: true }, 'credited'],
    [{ status: 'paid' }, 'paid'],
    [{ status: 'draft' }, 'not_sent'],
    [{ status: 'cancelled' }, 'not_sent'],
    [{ remaining: 0 }, 'paid'],
    [{ withCollections: true }, 'collections'],
    [{ customerExcluded: true }, 'customer_excluded'],
    [{ autogiro: true }, 'autogiro'],
    [{ recipient: null }, 'no_email'],
  ])('%o: %s', (overrides, reason) => {
    expect(decide({ invoice: invoice(overrides) })).toEqual({ kind: 'skip', reason })
    // Picking never overrides them.
    expect(decide({ invoice: invoice(overrides), picked: true })).toEqual({ kind: 'skip', reason })
  })

  it('reminds a partly paid invoice for what is left', () => {
    expect(decide({ invoice: invoice({ status: 'partially_paid', remaining: 250 }) })).toEqual({ kind: 'remind', level: 1 })
  })

  it('never before the day after the due date, even when picked', () => {
    expect(decide({ today: '2026-12-02', picked: true })).toEqual({ kind: 'skip', reason: 'not_overdue' })
    expect(decide({ today: '2026-12-03', picked: true })).toEqual({ kind: 'remind', level: 1 })
  })

  it('stops on a customer answer, a send in flight or failed, and a bounce', () => {
    const base = sent(1, '2026-12-17')
    expect(decide({ today: '2027-01-01', history: [{ ...base, responseType: 'marked_paid' }] })).toMatchObject({ reason: 'response' })
    expect(decide({ today: '2027-01-01', history: [{ ...base, responseType: 'disputed' }] })).toMatchObject({ reason: 'response' })
    expect(decide({ history: [{ ...base, status: 'reserved', sentOn: null }] })).toMatchObject({ reason: 'in_flight' })
    expect(decide({ history: [{ ...base, status: 'failed', sentOn: null }] })).toMatchObject({ reason: 'send_failed' })
    for (const providerStatus of ['bounced', 'complained', 'failed', 'suppressed'] as const) {
      expect(decide({ today: '2027-01-01', history: [{ ...base, providerStatus }] }), providerStatus).toMatchObject({ reason: 'undelivered' })
    }
    // Delivered or merely delayed does not stop it.
    expect(decide({ today: '2027-01-01', history: [{ ...base, providerStatus: 'delayed' }] })).toEqual({ kind: 'remind', level: 2 })
  })

  it('stops on a failed send whose outcome is unknown, or not on record', () => {
    const failed = { ...sent(1, '2026-12-17'), status: 'failed' as const, sentOn: null }
    expect(decide({ history: [{ ...failed, outcomeUnknown: true }] })).toMatchObject({ reason: 'send_failed' })
    expect(decide({ history: [failed] })).toMatchObject({ reason: 'send_failed' })
    expect(decide({ history: [{ ...failed, outcomeUnknown: true }], picked: true })).toMatchObject({ reason: 'send_failed' })
  })

  it('makes the level due again after a send the provider refused', () => {
    const refused = { ...sent(1, '2026-12-17'), status: 'failed' as const, sentOn: null, outcomeUnknown: false }
    expect(decide({ history: [refused] })).toEqual({ kind: 'remind', level: 1 })
    // Level 2 refused after level 1 went out: level 2 again, on its usual day.
    const history = [sent(1, '2026-12-17'), { ...refused, level: 2 as const }]
    expect(decide({ today: '2026-12-31', history })).toMatchObject({ reason: 'not_due', nextOn: '2027-01-01' })
    expect(decide({ today: '2027-01-01', history })).toEqual({ kind: 'remind', level: 2 })
  })
})

describe('sendsAutomatically', () => {
  it('only an invoice issued and delivered from Accounted', () => {
    expect(sendsAutomatically(invoice())).toBe(true)
    expect(sendsAutomatically(invoice({ imported: true }))).toBe(false)
    expect(sendsAutomatically(invoice({ delivery: 'not_delivered' }))).toBe(false)
    expect(sendsAutomatically(invoice({ delivery: 'no_history' }))).toBe(false)
  })
})

describe('reminderSchedule', () => {
  it('reads a strictly increasing 1 to 365 schedule, and falls back to the defaults otherwise', () => {
    expect(reminderSchedule({ reminder_days_level_1: 7, reminder_days_level_2: 21, reminder_days_level_3: 35 }).days).toEqual([7, 21, 35])
    for (const bad of [
      { reminder_days_level_1: 30, reminder_days_level_2: 20, reminder_days_level_3: 45 },
      { reminder_days_level_1: 0, reminder_days_level_2: 30, reminder_days_level_3: 45 },
      { reminder_days_level_1: 15, reminder_days_level_2: 30, reminder_days_level_3: 366 },
      { reminder_days_level_1: null, reminder_days_level_2: 30, reminder_days_level_3: 45 },
      {},
    ]) {
      expect(reminderSchedule(bad).days, JSON.stringify(bad)).toEqual([...DEFAULT_REMINDER_DAYS])
    }
  })
})
