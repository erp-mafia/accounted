import { describe, expect, it } from 'vitest'
import {
  companyNameKey,
  companyRoleLabelKey,
  createdLabels,
  formatCreatedMoment,
  orderCompanyCopies,
  sameNameCreatedLabels,
  type CreatedFormatter,
} from '../company-copies'

/** A formatter that shows which precision was asked for, independent of time zone and ICU. */
const fmt: CreatedFormatter = (iso, precision) => (precision === 'date' ? iso.slice(0, 10) : iso.slice(0, 16))

describe('companyNameKey', () => {
  it('ignores case, surrounding and repeated whitespace', () => {
    expect(companyNameKey('  Acme   AB ')).toBe(companyNameKey('acme ab'))
  })

  it('treats a precomposed and a decomposed letter as the same name', () => {
    expect(companyNameKey('Åkeri AB')).toBe(companyNameKey('Åkeri AB'))
  })

  it('keeps Swedish letters apart from their base letters', () => {
    expect(companyNameKey('Ärlig AB')).not.toBe(companyNameKey('Arlig AB'))
  })
})

describe('orderCompanyCopies', () => {
  it('puts the oldest copy first', () => {
    const rows = [
      { id: 'b', createdAt: '2026-10-02T14:05:00+00:00' },
      { id: 'a', createdAt: '2025-01-15T08:00:00+00:00' },
    ]
    expect(orderCompanyCopies(rows).map((r) => r.id)).toEqual(['a', 'b'])
  })

  it('puts a copy without a readable created time last and breaks ties by id', () => {
    const rows = [
      { id: 'z', createdAt: null },
      { id: 'y', createdAt: '2026-01-01T00:00:00+00:00' },
      { id: 'x', createdAt: '2026-01-01T00:00:00+00:00' },
      { id: 'w', createdAt: 'not a date' },
    ]
    expect(orderCompanyCopies(rows).map((r) => r.id)).toEqual(['x', 'y', 'w', 'z'])
  })

  it('does not change the array it was given', () => {
    const rows = [
      { id: 'b', createdAt: '2026-02-01T00:00:00+00:00' },
      { id: 'a', createdAt: '2026-01-01T00:00:00+00:00' },
    ]
    orderCompanyCopies(rows)
    expect(rows.map((r) => r.id)).toEqual(['b', 'a'])
  })
})

describe('createdLabels', () => {
  it('states the day when the days differ', () => {
    const labels = createdLabels(
      [
        { id: 'a', createdAt: '2025-01-15T08:00:00+00:00' },
        { id: 'b', createdAt: '2026-10-02T14:05:00+00:00' },
      ],
      fmt,
    )
    expect(Object.fromEntries(labels)).toEqual({ a: '2025-01-15', b: '2026-10-02' })
  })

  it('adds the clock time to every row once two rows share a day', () => {
    const labels = createdLabels(
      [
        { id: 'a', createdAt: '2026-10-02T08:00:00+00:00' },
        { id: 'b', createdAt: '2026-10-02T14:05:00+00:00' },
        { id: 'c', createdAt: '2025-01-15T08:00:00+00:00' },
      ],
      fmt,
    )
    expect(Object.fromEntries(labels)).toEqual({
      a: '2026-10-02T08:00',
      b: '2026-10-02T14:05',
      c: '2025-01-15T08:00',
    })
  })

  it('gives no line to a row without a created time', () => {
    const labels = createdLabels(
      [
        { id: 'a', createdAt: null },
        { id: 'b', createdAt: '2026-10-02T14:05:00+00:00' },
      ],
      fmt,
    )
    expect(labels.has('a')).toBe(false)
    expect(labels.get('b')).toBe('2026-10-02')
  })
})

describe('sameNameCreatedLabels', () => {
  it('gives a line only to companies whose name another listed company shares', () => {
    const labels = sameNameCreatedLabels(
      [
        { id: 'a', name: 'Acme AB', createdAt: '2025-01-15T08:00:00+00:00' },
        { id: 'b', name: 'acme  ab', createdAt: '2026-10-02T14:05:00+00:00' },
        { id: 'c', name: 'Other AB', createdAt: '2026-10-02T14:05:00+00:00' },
      ],
      fmt,
    )
    expect(Object.fromEntries(labels)).toEqual({ a: '2025-01-15', b: '2026-10-02' })
  })

  it('chooses the precision within each group of namesakes on its own', () => {
    const labels = sameNameCreatedLabels(
      [
        { id: 'a1', name: 'Acme AB', createdAt: '2026-10-02T08:00:00+00:00' },
        { id: 'a2', name: 'Acme AB', createdAt: '2026-10-02T14:05:00+00:00' },
        { id: 'b1', name: 'Beta AB', createdAt: '2026-10-02T08:00:00+00:00' },
        { id: 'b2', name: 'Beta AB', createdAt: '2025-01-15T08:00:00+00:00' },
      ],
      fmt,
    )
    expect(Object.fromEntries(labels)).toEqual({
      a1: '2026-10-02T08:00',
      a2: '2026-10-02T14:05',
      b1: '2026-10-02',
      b2: '2025-01-15',
    })
  })

  it('gives no lines when every name is its own', () => {
    expect(
      sameNameCreatedLabels(
        [
          { id: 'a', name: 'Acme AB', createdAt: '2025-01-15T08:00:00+00:00' },
          { id: 'b', name: 'Beta AB', createdAt: '2025-01-15T08:00:00+00:00' },
        ],
        fmt,
      ).size,
    ).toBe(0)
  })
})

describe('formatCreatedMoment', () => {
  // A local wall-clock time (no offset), so the expectation holds in any time zone.
  const iso = '2026-03-12T14:05:00'

  it('states the day at date precision', () => {
    expect(formatCreatedMoment(iso, 'date', 'sv')).toBe('12 mars 2026')
  })

  it('adds the clock time at minute precision', () => {
    expect(formatCreatedMoment(iso, 'minute', 'sv')).toBe('12 mars 2026 14:05')
  })

  it('follows the UI language', () => {
    expect(formatCreatedMoment(iso, 'date', 'en')).toBe('Mar 12, 2026')
  })
})

describe('companyRoleLabelKey', () => {
  it('names every company role by its settings label key', () => {
    expect(companyRoleLabelKey('owner')).toBe('members_role_owner')
    expect(companyRoleLabelKey('admin')).toBe('members_role_admin')
    expect(companyRoleLabelKey('member')).toBe('members_role_member')
    expect(companyRoleLabelKey('viewer')).toBe('members_role_viewer')
    expect(companyRoleLabelKey('invoicer')).toBe('members_role_invoicer')
  })

  it('has no key for a value the app does not know', () => {
    expect(companyRoleLabelKey('superuser')).toBeNull()
    expect(companyRoleLabelKey('toString')).toBeNull()
    expect(companyRoleLabelKey(null)).toBeNull()
    expect(companyRoleLabelKey(undefined)).toBeNull()
  })
})
