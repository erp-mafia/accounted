import { describe, it, expect } from 'vitest'
import {
  countByCompany,
  deadlineUrgency,
  pickNextDeadlines,
  sortClientRows,
  filterClientRows,
  type ClientOverviewRow,
} from '../aggregate'

function isoDaysFromNow(days: number): string {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + days)
  // Local date parts, not toISOString(): UTC conversion would shift the day
  // in timezones ahead of UTC and skew the day math under test.
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function makeRow(overrides: Partial<ClientOverviewRow> = {}): ClientOverviewRow {
  return {
    companyId: 'c-1',
    name: 'Alpha AB',
    orgNumber: null,
    unbookedCount: 0,
    inboxCount: 0,
    nextDeadline: null,
    lastBookedDate: null,
    ...overrides,
  }
}

describe('countByCompany', () => {
  it('counts rows per company id', () => {
    const counts = countByCompany([
      { company_id: 'a' },
      { company_id: 'b' },
      { company_id: 'a' },
      { company_id: 'a' },
    ])
    expect(counts.get('a')).toBe(3)
    expect(counts.get('b')).toBe(1)
    expect(counts.get('c')).toBeUndefined()
  })

  it('returns an empty map for no rows', () => {
    expect(countByCompany([]).size).toBe(0)
  })
})

describe('deadlineUrgency', () => {
  it('flags overdue on status overdue', () => {
    expect(
      deadlineUrgency({ due_date: isoDaysFromNow(30), status: 'overdue' }),
    ).toBe('overdue')
  })

  it('flags overdue on a passed due date even before the cron sweeps', () => {
    expect(
      deadlineUrgency({ due_date: isoDaysFromNow(-1), status: 'upcoming' }),
    ).toBe('overdue')
  })

  it('flags action_needed inside the 14-day window (status engine semantics)', () => {
    expect(
      deadlineUrgency({ due_date: isoDaysFromNow(14), status: 'upcoming' }),
    ).toBe('action_needed')
    expect(
      deadlineUrgency({ due_date: isoDaysFromNow(1), status: 'in_progress' }),
    ).toBe('action_needed')
  })

  it('keeps far-future deadlines as upcoming', () => {
    expect(
      deadlineUrgency({ due_date: isoDaysFromNow(15), status: 'upcoming' }),
    ).toBe('upcoming')
  })
})

describe('pickNextDeadlines', () => {
  it('picks the earliest due date per company from unsorted input', () => {
    const next = pickNextDeadlines([
      {
        company_id: 'a',
        title: 'Later',
        due_date: isoDaysFromNow(40),
        tax_deadline_type: null,
        status: 'upcoming',
      },
      {
        company_id: 'a',
        title: 'Sooner',
        due_date: isoDaysFromNow(2),
        tax_deadline_type: 'vat_declaration',
        status: 'action_needed',
      },
      {
        company_id: 'b',
        title: 'Only',
        due_date: isoDaysFromNow(60),
        tax_deadline_type: null,
        status: 'upcoming',
      },
    ])

    expect(next.get('a')).toEqual({
      title: 'Sooner',
      dueDate: isoDaysFromNow(2),
      taxDeadlineType: 'vat_declaration',
      urgency: 'action_needed',
    })
    expect(next.get('b')?.urgency).toBe('upcoming')
  })
})

describe('sortClientRows', () => {
  it('puts overdue-deadline companies first, then sorts by unbooked count', () => {
    const rows = [
      makeRow({ companyId: 'calm', name: 'Calm AB', unbookedCount: 50 }),
      makeRow({
        companyId: 'late',
        name: 'Late AB',
        unbookedCount: 0,
        nextDeadline: {
          title: 'Moms',
          dueDate: isoDaysFromNow(-5),
          taxDeadlineType: 'vat_declaration',
          urgency: 'overdue',
        },
      }),
      makeRow({ companyId: 'busy', name: 'Busy AB', unbookedCount: 120 }),
    ]

    expect(sortClientRows(rows).map((r) => r.companyId)).toEqual([
      'late',
      'busy',
      'calm',
    ])
  })

  it('orders overdue companies by earliest due date', () => {
    const rows = [
      makeRow({
        companyId: 'less-late',
        name: 'A',
        nextDeadline: {
          title: 'Moms',
          dueDate: isoDaysFromNow(-2),
          taxDeadlineType: null,
          urgency: 'overdue',
        },
      }),
      makeRow({
        companyId: 'most-late',
        name: 'B',
        nextDeadline: {
          title: 'AGI',
          dueDate: isoDaysFromNow(-30),
          taxDeadlineType: null,
          urgency: 'overdue',
        },
      }),
    ]

    expect(sortClientRows(rows).map((r) => r.companyId)).toEqual([
      'most-late',
      'less-late',
    ])
  })

  it('tie-breaks by name so the list is stable', () => {
    const rows = [
      makeRow({ companyId: 'b', name: 'Beta AB', unbookedCount: 3 }),
      makeRow({ companyId: 'a', name: 'Alfa AB', unbookedCount: 3 }),
    ]
    expect(sortClientRows(rows).map((r) => r.companyId)).toEqual(['a', 'b'])
  })

  it('does not mutate the input array', () => {
    const rows = [
      makeRow({ companyId: 'x', unbookedCount: 1 }),
      makeRow({ companyId: 'y', unbookedCount: 9 }),
    ]
    const before = rows.map((r) => r.companyId)
    sortClientRows(rows)
    expect(rows.map((r) => r.companyId)).toEqual(before)
  })
})

describe('filterClientRows', () => {
  const rows = [
    makeRow({ companyId: 'a', name: 'Alfa Bygg AB', orgNumber: '556012-5790' }),
    makeRow({ companyId: 'b', name: 'Beta Konsult AB', orgNumber: '5591234567' }),
  ]

  it('returns everything for an empty query', () => {
    expect(filterClientRows(rows, '  ')).toHaveLength(2)
  })

  it('matches case-insensitively on name', () => {
    expect(filterClientRows(rows, 'alfa').map((r) => r.companyId)).toEqual(['a'])
  })

  it('matches org numbers ignoring separators', () => {
    expect(filterClientRows(rows, '5560125790').map((r) => r.companyId)).toEqual(['a'])
    expect(filterClientRows(rows, '559123').map((r) => r.companyId)).toEqual(['b'])
  })

  it('returns nothing on a miss', () => {
    expect(filterClientRows(rows, 'gamma')).toHaveLength(0)
  })
})
