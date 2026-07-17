import { describe, it, expect } from 'vitest'
import { generateCalendarFeed } from '../ics-generator'
import type { Deadline } from '@/types'

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
