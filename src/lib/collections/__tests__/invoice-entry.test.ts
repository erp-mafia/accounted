import { describe, expect, it } from 'vitest'
import { isOverdueUnpaid, readsOverdue, remindersAside, showSendToCollection, type EntryCase } from '../invoice-entry'

const today = '2026-10-06'
const overdue = { status: 'sent', due_date: '2026-09-30', remaining_amount: 1250 }

const watched: EntryCase = { stage: 'invoice_sent', isOpen: true, submissionStatus: 'registered', actions: ['start', 'withdraw'] }

describe('isOverdueUnpaid', () => {
  it('reads overdue from the due date, never from the status', () => {
    expect(isOverdueUnpaid(overdue, today)).toBe(true)
    expect(isOverdueUnpaid({ ...overdue, due_date: today }, today)).toBe(false)
    expect(isOverdueUnpaid({ ...overdue, status: 'overdue', due_date: '2026-10-20' }, today)).toBe(false)
    expect(isOverdueUnpaid({ ...overdue, due_date: null }, today)).toBe(false)
  })

  it('needs an owed status and something left to pay', () => {
    expect(isOverdueUnpaid({ ...overdue, status: 'partially_paid' }, today)).toBe(true)
    expect(isOverdueUnpaid({ ...overdue, status: 'paid' }, today)).toBe(false)
    expect(isOverdueUnpaid({ ...overdue, status: 'draft' }, today)).toBe(false)
    expect(isOverdueUnpaid({ ...overdue, remaining_amount: 0 }, today)).toBe(false)
  })
})

describe('readsOverdue (the list and the invoice header agree)', () => {
  it('reads a sent invoice past its due date as overdue while collections is in play', () => {
    expect(readsOverdue(overdue, today)).toBe(true)
  })

  it('keeps the reminders status alone while collections is not in play', () => {
    expect(readsOverdue(overdue, undefined)).toBe(false)
    expect(readsOverdue({ ...overdue, status: 'overdue' }, undefined)).toBe(true)
  })

  it('never reads a paid, partly paid, settled or undated invoice as overdue by date', () => {
    expect(readsOverdue({ ...overdue, status: 'paid' }, today)).toBe(false)
    expect(readsOverdue({ ...overdue, status: 'partially_paid' }, today)).toBe(false)
    expect(readsOverdue({ ...overdue, remaining_amount: 0 }, today)).toBe(false)
    expect(readsOverdue({ ...overdue, due_date: today }, today)).toBe(false)
    expect(readsOverdue({ ...overdue, status: 'overdue', due_date: null }, today)).toBe(false)
  })
})

describe('showSendToCollection', () => {
  it('offers an overdue unpaid invoice with no case while the start entry points show', () => {
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: null, today })).toBe(true)
    expect(showSendToCollection({ invoice: overdue, start: 'upgrade', openCase: null, today })).toBe(true)
    expect(showSendToCollection({ invoice: overdue, start: 'activate', openCase: null, today })).toBe(true)
  })

  it('hides it behind closed start gates and for an invoice not yet overdue', () => {
    expect(showSendToCollection({ invoice: overdue, start: 'hidden', openCase: null, today })).toBe(false)
    expect(showSendToCollection({ invoice: { ...overdue, due_date: '2026-10-10' }, start: 'ready', openCase: null, today })).toBe(false)
  })

  it('hides it while a case is open, except a delivered claim the provider offers to start', () => {
    const inCollection: EntryCase = { ...watched, stage: 'reminder', actions: ['pause'] }
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: inCollection, today })).toBe(false)
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: watched, today })).toBe(true)
    // A registered claim not started yet is collection, and can still be started.
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: { ...watched, stage: 'registered' }, today })).toBe(true)
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: { ...watched, actions: ['withdraw'] }, today })).toBe(false)
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: { ...watched, submissionStatus: 'submitted' }, today })).toBe(false)
  })

  it('offers a new handover after a closed or refused case', () => {
    const closed: EntryCase = { stage: 'closed_other', isOpen: false, submissionStatus: 'failed', actions: [] }
    expect(showSendToCollection({ invoice: overdue, start: 'ready', openCase: closed, today })).toBe(true)
  })
})

describe('remindersAside', () => {
  const active = { state: 'active', ladderMode: 'off' as const, ladderDaysAfterDue: null }

  it('says the provider reminds while the case is past delivery', () => {
    expect(
      remindersAside({ invoice: { status: 'overdue' }, connection: null, openCase: { stage: 'collection', isOpen: true } }),
    ).toEqual({ key: 'reminders_by_provider' })
    // A registered claim is with the provider, not with our own reminders.
    expect(
      remindersAside({ invoice: { status: 'overdue' }, connection: null, openCase: { stage: 'registered', isOpen: true } }),
    ).toEqual({ key: 'reminders_by_provider' })
  })

  it('says nobody reminds before a handover when the ladder is off', () => {
    expect(remindersAside({ invoice: { status: 'sent' }, connection: active, openCase: null })).toEqual({ key: 'reminders_none' })
  })

  it('names the batch day when the ladder is staged', () => {
    expect(
      remindersAside({ invoice: { status: 'sent' }, connection: { ...active, ladderMode: 'staged', ladderDaysAfterDue: 10 }, openCase: null }),
    ).toEqual({ key: 'reminders_batch', days: 10 })
    expect(
      remindersAside({ invoice: { status: 'sent' }, connection: { ...active, ladderMode: 'staged' }, openCase: null }),
    ).toBeNull()
  })

  it('keeps the card own aside without an active connection, for a paid invoice or a delivered claim', () => {
    expect(remindersAside({ invoice: { status: 'sent' }, connection: null, openCase: null })).toBeNull()
    expect(remindersAside({ invoice: { status: 'sent' }, connection: { ...active, state: 'pending' }, openCase: null })).toBeNull()
    expect(remindersAside({ invoice: { status: 'paid' }, connection: active, openCase: null })).toBeNull()
    expect(remindersAside({ invoice: { status: 'sent' }, connection: active, openCase: { stage: 'invoice_sent', isOpen: true } })).toBeNull()
  })
})
