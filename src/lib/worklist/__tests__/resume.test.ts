import { describe, it, expect } from 'vitest'
import {
  mergeResumeItems,
  isSalaryRunLate,
  RESUME_MAX_ROWS,
  type ResumeItem,
} from '../resume'

function item(overrides: Partial<ResumeItem>): ResumeItem {
  return {
    kind: 'journal_draft',
    ref: `journal:${Math.abs(overrides.updated_at?.length ?? 1)}`,
    href: '/bookkeeping/x',
    context: null,
    updated_at: '2026-07-01T10:00:00Z',
    ...overrides,
  }
}

describe('mergeResumeItems', () => {
  it('orders by updated_at desc', () => {
    const merged = mergeResumeItems([
      item({ ref: 'a', updated_at: '2026-07-01T10:00:00Z' }),
      item({ ref: 'b', updated_at: '2026-07-03T10:00:00Z' }),
      item({ ref: 'c', updated_at: '2026-07-02T10:00:00Z' }),
    ])
    expect(merged.map((i) => i.ref)).toEqual(['b', 'c', 'a'])
  })

  it('boosts late items above newer non-late items', () => {
    const merged = mergeResumeItems([
      item({ ref: 'fresh', updated_at: '2026-07-20T10:00:00Z' }),
      item({ ref: 'late-old', late: true, updated_at: '2026-05-01T10:00:00Z' }),
    ])
    expect(merged[0].ref).toBe('late-old')
  })

  it('caps at RESUME_MAX_ROWS', () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      item({ ref: `r${i}`, updated_at: `2026-07-0${i + 1}T10:00:00Z` }),
    )
    expect(mergeResumeItems(many)).toHaveLength(RESUME_MAX_ROWS)
  })

  it('keeps late-first ordering stable within groups', () => {
    const merged = mergeResumeItems([
      item({ ref: 'late-new', late: true, updated_at: '2026-07-10T10:00:00Z' }),
      item({ ref: 'late-old', late: true, updated_at: '2026-06-10T10:00:00Z' }),
      item({ ref: 'plain', updated_at: '2026-07-22T10:00:00Z' }),
    ])
    expect(merged.map((i) => i.ref)).toEqual(['late-new', 'late-old', 'plain'])
  })

  it('does not mutate the input array', () => {
    const input = [
      item({ ref: 'a', updated_at: '2026-07-01T10:00:00Z' }),
      item({ ref: 'b', updated_at: '2026-07-02T10:00:00Z' }),
    ]
    const before = [...input]
    mergeResumeItems(input)
    expect(input).toEqual(before)
  })
})

describe('isSalaryRunLate', () => {
  const now = new Date('2026-07-23T12:00:00Z')

  it('flags a run two months past its period', () => {
    expect(isSalaryRunLate(2026, 5, now)).toBe(true)
  })

  it('does not flag last month', () => {
    expect(isSalaryRunLate(2026, 6, now)).toBe(false)
  })

  it('does not flag the current period', () => {
    expect(isSalaryRunLate(2026, 7, now)).toBe(false)
  })

  it('handles year boundaries', () => {
    expect(isSalaryRunLate(2025, 12, now)).toBe(true)
  })
})
