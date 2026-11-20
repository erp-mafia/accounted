import { describe, it, expect } from 'vitest'
import { generateCalendarFeed } from '../ics-generator'
import type { Deadline, Invoice } from '@/types'

function makeDeadline(overrides: Partial<Deadline>): Deadline {
  return {
    id: 'd-1',
    user_id: 'user-1',
    company_id: 'company-1',
    title: 'Deadline',
    due_date: '2027-03-12',
    due_time: null,
    deadline_type: 'other',
    priority: 'normal',
    is_completed: false,
    completed_at: null,
    customer_id: null,
    is_auto_generated: false,
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    tax_deadline_type: null,
    tax_period: null,
    source: 'user',
    reminder_offsets: null,
    status: 'upcoming',
    status_changed_at: '2026-01-01T00:00:00Z',
    dismissed_at: null,
    linked_report_type: null,
    linked_report_period: null,
    ...overrides,
  } as Deadline
}

const SYSTEM_DEADLINE = makeDeadline({
  id: 'sys-1',
  title: 'Momsdeklaration Q1 2027',
  deadline_type: 'tax',
  tax_deadline_type: 'moms_quarterly',
  tax_period: '2027-Q1',
  source: 'system',
})

const USER_DEADLINE = makeDeadline({
  id: 'usr-1',
  title: 'Skicka avtal till kunden',
  source: 'user',
})

describe('generateCalendarFeed deadline filtering', () => {
  it('includes system and user deadlines when tax deadlines are on', async () => {
    const ics = await generateCalendarFeed(
      { deadlines: [SYSTEM_DEADLINE, USER_DEADLINE], invoices: [] },
      { includeTaxDeadlines: true, includeInvoices: false },
    )
    expect(ics).toContain('Momsdeklaration Q1 2027')
    expect(ics).toContain('Skicka avtal till kunden')
  })

  it('keeps user-created deadlines when tax deadlines are off', async () => {
    // The flag governs system-generated rows only; hiding the user's own
    // manual deadlines with it was a bug.
    const ics = await generateCalendarFeed(
      { deadlines: [SYSTEM_DEADLINE, USER_DEADLINE], invoices: [] },
      { includeTaxDeadlines: false, includeInvoices: false },
    )
    expect(ics).not.toContain('Momsdeklaration Q1 2027')
    expect(ics).toContain('Skicka avtal till kunden')
  })
})

describe('generateCalendarFeed alarm and duration syntax (RFC 5545 3.3.6)', () => {
  // crm#1284: the ics package kept a dangling "T" on whole-day durations
  // (TRIGGER:-P14DT, TRIGGER:-PT), which is not a valid duration.
  const DANGLING_T = /^(TRIGGER|DURATION):[+-]?P(\d+W)?(\d+D)?T\r?$/m

  it('writes whole-day reminder offsets as valid triggers', async () => {
    const ics = await generateCalendarFeed(
      { deadlines: [makeDeadline({ ...SYSTEM_DEADLINE, reminder_offsets: [14, 7, 1, 0] })], invoices: [] },
      { includeTaxDeadlines: true, includeInvoices: false },
    )
    expect(ics).toContain('TRIGGER:-P14D\r\n')
    expect(ics).toContain('TRIGGER:-P7D\r\n')
    expect(ics).toContain('TRIGGER:-P1D\r\n')
    expect(ics).toContain('TRIGGER:PT0S\r\n')
    expect(ics).not.toMatch(DANGLING_T)
  })

  it('keeps the default reminders and the one-hour event duration valid', async () => {
    const ics = await generateCalendarFeed(
      { deadlines: [USER_DEADLINE], invoices: [] },
      { includeTaxDeadlines: true, includeInvoices: false },
    )
    expect(ics).toContain('TRIGGER:-P7D\r\n')
    expect(ics).toContain('TRIGGER:-P1D\r\n')
    expect(ics).toContain('DURATION:PT1H\r\n')
    expect(ics).not.toMatch(DANGLING_T)
  })

  it('writes the all-day invoice event as a one-day duration', async () => {
    const invoice = {
      id: 'inv-1',
      invoice_number: '1001',
      due_date: '2027-03-12',
      total: 1250,
      currency: 'SEK',
      status: 'sent',
      customer: { name: 'Kund AB' },
    } as unknown as Invoice
    const ics = await generateCalendarFeed(
      { deadlines: [], invoices: [invoice] },
      { includeTaxDeadlines: true, includeInvoices: true },
    )
    expect(ics).toContain('DTSTART;VALUE=DATE:20270312')
    expect(ics).toContain('DURATION:P1D\r\n')
    expect(ics).toContain('TRIGGER:-P3D\r\n')
    expect(ics).not.toMatch(DANGLING_T)
  })

  it('writes deadline times as Swedish wall-clock times in UTC', async () => {
    const ics = await generateCalendarFeed(
      {
        deadlines: [
          makeDeadline({ id: 'w', due_date: '2027-02-12', due_time: null }),
          makeDeadline({ id: 's', due_date: '2027-06-30', due_time: null }),
          makeDeadline({ id: 't', due_date: '2027-02-15', due_time: '14:30:00' }),
        ],
        invoices: [],
      },
      { includeTaxDeadlines: true, includeInvoices: false },
    )
    expect(ics).toContain('DTSTART:20270212T080000Z')
    expect(ics).toContain('DTSTART:20270630T070000Z')
    expect(ics).toContain('DTSTART:20270215T133000Z')
  })
})
