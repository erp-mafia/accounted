import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { pickPreviousFiscalPeriod, resolvePreviousFiscalPeriod } from '../period-service'

type P = { id: string; period_start: string; period_end: string }
const y = (id: string, year: number): P => ({ id, period_start: `${year}-01-01`, period_end: `${year}-12-31` })
const Y2023 = y('2023', 2023)
const Y2024 = y('2024', 2024)
const current = { period_start: '2025-01-01' }

// The four rules "the previous year" was resolved by, as they stood:
const OLD = {
  // resultatrapport: the link, else the latest period ending before.
  linkElseLatest: (link: string | null, periods: P[]) =>
    (link ? periods.find((p) => p.id === link) : undefined)
    ?? [...periods].filter((p) => p.period_end < current.period_start).sort((a, b) => b.period_end.localeCompare(a.period_end))[0]
    ?? null,
  // SIE export: the latest period ending before, link ignored.
  latest: (_link: string | null, periods: P[]) =>
    [...periods].filter((p) => p.period_end < current.period_start).sort((a, b) => b.period_end.localeCompare(a.period_end))[0] ?? null,
  // annual report, iXBRL, continuity check: the link only.
  linkOnly: (link: string | null, periods: P[]) => (link ? periods.find((p) => p.id === link) ?? null : null),
  // tax depreciation: the link if adjacent (else none), without a link the adjacent one.
  taxDepreciation: (link: string | null, periods: P[]) => {
    if (link) {
      const linked = periods.find((p) => p.id === link)
      return linked && linked.period_end === '2024-12-31' ? linked : null
    }
    return periods.find((p) => p.period_end === '2024-12-31') ?? null
  },
}

// Parity: in the common case (a linked, adjacent chain) every old rule and the
// new one agree. The table records where they disagreed, and what the one rule
// now answers: the year ending the day before, or none.
describe('pickPreviousFiscalPeriod: parity with the four rules it replaced', () => {
  const cases: Array<{ name: string; link: string | null; periods: P[]; expected: P | null; old: Record<keyof typeof OLD, P | null> }> = [
    {
      name: 'linked and adjacent',
      link: '2024', periods: [Y2023, Y2024], expected: Y2024,
      old: { linkElseLatest: Y2024, latest: Y2024, linkOnly: Y2024, taxDepreciation: Y2024 },
    },
    {
      name: 'adjacent, never linked (old multi-year SIE imports)',
      link: null, periods: [Y2023, Y2024], expected: Y2024,
      old: { linkElseLatest: Y2024, latest: Y2024, linkOnly: null, taxDepreciation: Y2024 },
    },
    {
      name: 'a gap: 2024 missing, 2023 present, no link',
      link: null, periods: [Y2023], expected: null,
      old: { linkElseLatest: Y2023, latest: Y2023, linkOnly: null, taxDepreciation: null },
    },
    {
      name: 'a link across the gap to 2023, 2024 present',
      link: '2023', periods: [Y2023, Y2024], expected: Y2024,
      old: { linkElseLatest: Y2023, latest: Y2024, linkOnly: Y2023, taxDepreciation: null },
    },
    {
      name: 'a link across the gap to 2023, 2024 missing',
      link: '2023', periods: [Y2023], expected: null,
      old: { linkElseLatest: Y2023, latest: Y2023, linkOnly: Y2023, taxDepreciation: null },
    },
  ]

  it.each(cases)('$name', ({ link, periods, expected, old }) => {
    for (const [rule, answer] of Object.entries(old) as Array<[keyof typeof OLD, P | null]>) {
      expect(OLD[rule](link, periods), rule).toEqual(answer)
    }
    expect(pickPreviousFiscalPeriod({ ...current, previous_period_id: link }, periods)).toEqual(expected)
  })
})

describe('resolvePreviousFiscalPeriod', () => {
  it('takes the linked period when it ends the day before', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: Y2024, error: null })
    const result = await resolvePreviousFiscalPeriod(q.supabase as never, 'c1', { ...current, previous_period_id: '2024' }, 'id, period_start, period_end')
    expect(result).toEqual(Y2024)
  })

  it('falls back to the period ending the day before when the link is not adjacent', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: Y2023, error: null })
    q.enqueue({ data: Y2024, error: null })
    const result = await resolvePreviousFiscalPeriod(q.supabase as never, 'c1', { ...current, previous_period_id: '2023' }, 'id, period_start, period_end')
    expect(result).toEqual(Y2024)
  })

  it('answers null when no period ends the day before', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: null })
    expect(await resolvePreviousFiscalPeriod(q.supabase as never, 'c1', current, 'id, period_end')).toBeNull()
  })

  it('throws on a failed read', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: { message: 'timeout' } })
    await expect(resolvePreviousFiscalPeriod(q.supabase as never, 'c1', current, 'id, period_end')).rejects.toThrow(
      'Failed to read the previous fiscal year: timeout',
    )
  })
})
