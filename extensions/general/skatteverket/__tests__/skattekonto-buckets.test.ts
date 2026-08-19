import { describe, it, expect } from 'vitest'
import { splitTransactions } from '../lib/skattekonto-buckets'
import type { StoredSkattekontoTransaction } from '../types'

function makeRow(
  overrides: Partial<StoredSkattekontoTransaction> = {},
): StoredSkattekontoTransaction {
  return {
    id: 'row-1',
    company_id: 'co-1',
    transaktionsidentitet: null,
    dedup_key: 'h:abc',
    transaktionsdatum: '2026-05-12',
    forfallodatum: null,
    ranteberakningsdatum: null,
    transaktionstext: 'Test',
    belopp_skatteverket: 100,
    belopp_kronofogden: 0,
    status: 'upcoming',
    journal_entry_id: null,
    is_ignored: false,
    source: 'api',
    file_import_id: null,
    imported_at: '2026-05-15T10:00:00Z',
    updated_at: '2026-05-15T10:00:00Z',
    ...overrides,
  }
}

describe('splitTransactions', () => {
  const today = '2026-05-15'

  it('routes booked rows to booked regardless of date', () => {
    const rows = [
      makeRow({ id: 'a', status: 'booked', transaktionsdatum: '2026-05-12' }),
      makeRow({ id: 'b', status: 'booked', transaktionsdatum: '2026-06-01' }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.booked.map(r => r.id)).toEqual(['a', 'b'])
    expect(out.overdue).toEqual([])
    expect(out.upcoming).toEqual([])
  })

  it('routes upcoming with past forfallodatum to overdue', () => {
    // The reported bug: SKV still has it in kommande on 2026-05-15
    // even though forfallodatum was 2026-05-12.
    const rows = [
      makeRow({ id: 'a', status: 'upcoming', forfallodatum: '2026-05-12' }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.overdue.map(r => r.id)).toEqual(['a'])
    expect(out.upcoming).toEqual([])
  })

  it('routes upcoming with future forfallodatum to upcoming', () => {
    const rows = [
      makeRow({ id: 'a', status: 'upcoming', forfallodatum: '2026-06-12' }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.upcoming.map(r => r.id)).toEqual(['a'])
    expect(out.overdue).toEqual([])
  })

  it('treats today as upcoming, not overdue', () => {
    const rows = [
      makeRow({ id: 'a', status: 'upcoming', forfallodatum: today }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.upcoming.map(r => r.id)).toEqual(['a'])
    expect(out.overdue).toEqual([])
  })

  it('falls back to transaktionsdatum when forfallodatum is null', () => {
    const rows = [
      makeRow({
        id: 'past',
        status: 'upcoming',
        forfallodatum: null,
        transaktionsdatum: '2026-05-10',
      }),
      makeRow({
        id: 'future',
        status: 'upcoming',
        forfallodatum: null,
        transaktionsdatum: '2026-05-20',
      }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.overdue.map(r => r.id)).toEqual(['past'])
    expect(out.upcoming.map(r => r.id)).toEqual(['future'])
  })

  it('handles a mixed input', () => {
    const rows = [
      makeRow({ id: 'b1', status: 'booked' }),
      makeRow({ id: 'o1', status: 'upcoming', forfallodatum: '2026-05-01' }),
      makeRow({ id: 'u1', status: 'upcoming', forfallodatum: '2026-05-31' }),
      makeRow({ id: 'o2', status: 'upcoming', forfallodatum: '2026-05-14' }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.booked.map(r => r.id)).toEqual(['b1'])
    expect(out.overdue.map(r => r.id)).toEqual(['o1', 'o2'])
    expect(out.upcoming.map(r => r.id)).toEqual(['u1'])
  })
  it('routes ignored rows to the ignored bucket regardless of status', () => {
    const rows = [
      makeRow({ id: 'a', status: 'booked', is_ignored: true }),
      makeRow({ id: 'b', status: 'upcoming', forfallodatum: '2026-05-01', is_ignored: true }),
      makeRow({ id: 'c', status: 'booked' }),
    ]
    const out = splitTransactions(rows, today)
    expect(out.ignored.map(r => r.id)).toEqual(['a', 'b'])
    expect(out.booked.map(r => r.id)).toEqual(['c'])
    expect(out.overdue).toEqual([])
    expect(out.upcoming).toEqual([])
  })
})
