import { describe, it, expect } from 'vitest'
import {
  entityMagnitude,
  selectAccountRing,
  MAX_ACCOUNTS,
} from '@/components/agent-knowledge/ledger-graph-magnitude'
import type { DeepEntity } from '@/lib/agent-context/ledger-deep'

function entity(overrides: Partial<DeepEntity> & { key: string }): DeepEntity {
  return {
    name: overrides.key,
    variants: [overrides.key],
    variant_count: 1,
    occurrences: 1,
    total_amount: 0,
    first_seen: '2026-01-01',
    last_seen: '2026-06-01',
    cadence_days: null,
    dominant_account_number: '5420',
    dominant_account_share: 0.8,
    dominant_account_count: 4,
    dominant_account_total: 5,
    kind: 'counterparty',
    ...overrides,
  }
}

/** Share of the ring an account gets, ignoring the fixed inter-wedge padding. */
function share(weight: number, totalWeight: number): number {
  return weight / totalWeight
}

describe('selectAccountRing', () => {
  it('weighs a SEK-only company by amount, exactly as before', () => {
    const ring = selectAccountRing([
      entity({ key: 'a', dominant_account_number: '5420', total_amount: 24000, occurrences: 12 }),
      entity({ key: 'b', dominant_account_number: '5420', total_amount: 6000, occurrences: 3 }),
      entity({ key: 'c', dominant_account_number: '6540', total_amount: 10000, occurrences: 2 }),
    ])

    expect(ring.basis).toBe('amount')
    expect(ring.groups.map((g) => g.number)).toEqual(['5420', '6540'])
    expect(ring.groups.map((g) => g.weight)).toEqual([30000, 10000])
    expect(ring.totalWeight).toBe(40000)
    expect(ring.maxMagnitude).toBe(24000)
    expect(ring.truncated).toBe(false)
    // Biggest spender first inside the wedge: it lands at the angular centre.
    expect(ring.groups[0].items.map((e) => e.key)).toEqual(['a', 'b'])
  })

  it('never puts kronor and booking counts in the same denominator', () => {
    // 6570 is booked 4 times but carries no usable amount: on the counterparty
    // side that is a spend of 0, and it used to fall back to its booking count
    // while 5420 stayed in kronor.
    const entities = [
      entity({ key: 'big', dominant_account_number: '5420', total_amount: 250000, occurrences: 6 }),
      entity({ key: 'nil', dominant_account_number: '6570', total_amount: 0, occurrences: 4 }),
    ]

    const ring = selectAccountRing(entities)

    expect(ring.basis).toBe('volume')
    expect(ring.groups.map((g) => [g.number, g.weight])).toEqual([
      ['5420', 6],
      ['6570', 4],
    ])
    expect(ring.totalWeight).toBe(10)
    // No weight is a kronor figure, so nothing can be summed across units.
    expect(ring.groups.every((g) => g.weight < 1000)).toBe(true)

    // The pre-fix mix: 250 000 kr against 4 bookings in one denominator gave
    // 6570 a wedge of 0.0016% of the circle, an invisible sliver. Now it is a
    // legible tenth of the ring.
    const mixedShare = share(4, 250000 + 4)
    expect(mixedShare).toBeLessThan(0.0001)
    expect(share(ring.groups[1].weight, ring.totalWeight)).toBeCloseTo(0.4, 10)
  })

  it('keeps an account with no usable amount inside the truncation cap', () => {
    // Ten accounts, cap is nine. The amount-less one is the most-booked account
    // the company has, so dropping it is the worst possible choice.
    const entities: DeepEntity[] = [
      entity({ key: 'unpriced', dominant_account_number: '4000', total_amount: 0, occurrences: 40 }),
    ]
    for (let i = 0; i < 9; i++) {
      entities.push(
        entity({
          key: `priced-${i}`,
          dominant_account_number: `55${10 + i}`,
          total_amount: 100000 + i,
          occurrences: 2,
        }),
      )
    }

    const ring = selectAccountRing(entities)

    expect(ring.groups).toHaveLength(MAX_ACCOUNTS)
    expect(ring.truncated).toBe(true)
    expect(ring.groups.map((g) => g.number)).toContain('4000')
    // It is the largest wedge, not a survivor by luck.
    const unpriced = ring.groups.find((g) => g.number === '4000')
    expect(unpriced?.weight).toBe(40)
    expect(Math.max(...ring.groups.map((g) => g.weight))).toBe(40)
  })

  it('sizes nodes against a maximum measured in the same unit', () => {
    const ring = selectAccountRing([
      entity({ key: 'a', dominant_account_number: '5420', total_amount: 0, occurrences: 9 }),
      entity({ key: 'b', dominant_account_number: '6540', total_amount: 500, occurrences: 3 }),
    ])

    expect(ring.basis).toBe('volume')
    expect(ring.maxMagnitude).toBe(9)
    // The 500 is not compared against 9: under a volume ring it is not read.
    expect(entityMagnitude(ring.groups[1].items[0], ring.basis)).toBe(3)
  })

  it('truncates payees per wedge without changing what the wedge weighs', () => {
    const items = Array.from({ length: 8 }, (_, i) =>
      entity({ key: `e${i}`, dominant_account_number: '5420', total_amount: 1000, occurrences: 1 }),
    )

    const ring = selectAccountRing(items, { maxPerAccount: 6 })

    expect(ring.truncated).toBe(true)
    expect(ring.groups[0].items).toHaveLength(6)
    expect(ring.groups[0].weight).toBe(8000)
  })

  it('drops entities with no dominant account and survives an empty ledger', () => {
    const ring = selectAccountRing([
      entity({ key: 'orphan', dominant_account_number: null, total_amount: 900, occurrences: 2 }),
    ])

    expect(ring.groups).toEqual([])
    expect(ring.basis).toBe('volume')
    // Safe divisors: the layout divides by both.
    expect(ring.totalWeight).toBe(1)
    expect(ring.maxMagnitude).toBe(1)
  })

  it('is deterministic when weights tie', () => {
    const build = (order: string[]) =>
      selectAccountRing(
        order.map((number) =>
          entity({ key: number, dominant_account_number: number, total_amount: 5000, occurrences: 1 }),
        ),
        { maxAccounts: 2 },
      )

    expect(build(['6000', '5000', '7000']).groups.map((g) => g.number)).toEqual(['5000', '6000'])
    expect(build(['7000', '6000', '5000']).groups.map((g) => g.number)).toEqual(['5000', '6000'])
  })
})

describe('entityMagnitude', () => {
  it('clamps a negative amount rather than subtracting it from a sibling', () => {
    const e = entity({ key: 'credit', total_amount: -4000, occurrences: 2 })
    expect(entityMagnitude(e, 'amount')).toBe(0)
    expect(entityMagnitude(e, 'volume')).toBe(2)
  })
})
