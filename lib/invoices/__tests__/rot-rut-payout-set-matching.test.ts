import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import type { RotRutPayoutRequestCandidate } from '../rot-rut-payout-matching'
import {
  findRotRutPayoutSetMatch,
  matchTransactionsToRotRutPayoutSets,
} from '../rot-rut-payout-set-matching'

function makeRequest(
  id: string,
  requestedTotal: number,
  overrides: Partial<RotRutPayoutRequestCandidate> = {},
): RotRutPayoutRequestCandidate {
  return {
    id,
    name: `ROT ${id}`,
    deduction_type: 'rot',
    status: 'submitted',
    requested_total: requestedTotal,
    decided_total: null,
    settlement_journal_entry_id: null,
    ...overrides,
  }
}

const A = makeRequest('rr-a', 3000)
const B = makeRequest('rr-b', 2250)
const C = makeRequest('rr-c', 1200.5)

describe('findRotRutPayoutSetMatch', () => {
  it('returns null with no open requests or no closing set', () => {
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 3000 }), [])).toBeNull()
    // 3000 + 2250 = 5250; 5000 closes nothing.
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 5000 }), [A, B])).toBeNull()
  })

  it('matches a single begäran exactly like the 1:1 matcher', () => {
    const match = findRotRutPayoutSetMatch(
      makeTransaction({ amount: 3000, description: 'Insättning' }),
      [A, B],
    )
    expect(match).toEqual({ requests: [A], total: 3000, confidence: 0.85, matchMethod: 'amount' })
  })

  it('matches the sum of several begäran paid in one transfer', () => {
    const tx = makeTransaction({ amount: 6450.5, description: 'Skatteverket utbetalning' })
    const match = findRotRutPayoutSetMatch(tx, [A, B, C])
    expect(match?.requests.map((r) => r.id).sort()).toEqual(['rr-a', 'rr-b', 'rr-c'])
    expect(match?.total).toBe(6450.5)
    expect(match?.confidence).toBe(0.9)
    expect(match?.matchMethod).toBe('amount_sum_skatteverket')
  })

  it('sums against the beslut amount when one is recorded', () => {
    const decided = makeRequest('rr-d', 3000, { decided_total: 2500 })
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 4750 }), [decided, B])?.total).toBe(4750)
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 5250 }), [decided, B])).toBeNull()
  })

  it('still matches when Skatteverket is not named, at lower confidence', () => {
    const tx = makeTransaction({ amount: 5250, description: 'Insättning' })
    const match = findRotRutPayoutSetMatch(tx, [A, B])
    expect(match?.requests.map((r) => r.id).sort()).toEqual(['rr-a', 'rr-b'])
    expect(match?.confidence).toBe(0.8)
    expect(match?.matchMethod).toBe('amount_sum')
  })

  it('never fuzzy-matches: an öre off closes nothing', () => {
    const tx = makeTransaction({ amount: 5250.01, description: 'Skatteverket' })
    expect(findRotRutPayoutSetMatch(tx, [A, B])).toBeNull()
  })

  it('refuses an ambiguous answer: two different sets of the same size close the row', () => {
    const twin = makeRequest('rr-twin', 3000)
    // {A, B} and {twin, B} both sum to 5250.
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 5250 }), [A, B, twin])).toBeNull()
    // With the twin gone the answer is unique again.
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 5250 }), [A, B])).not.toBeNull()
  })

  it('ignores expenses, non-SEK rows and unmatchable requests', () => {
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: -5250 }), [A, B])).toBeNull()
    expect(
      findRotRutPayoutSetMatch(makeTransaction({ amount: 5250, currency: 'EUR' as never }), [A, B]),
    ).toBeNull()
    const settled = makeRequest('rr-a', 3000, { settlement_journal_entry_id: 'je-1' })
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 5250 }), [settled, B])).toBeNull()
    const cancelled = makeRequest('rr-a', 3000, { status: 'cancelled' })
    expect(findRotRutPayoutSetMatch(makeTransaction({ amount: 5250 }), [cancelled, B])).toBeNull()
  })

  it('respects the set-size cap', () => {
    const tx = makeTransaction({ amount: 6450.5 })
    expect(findRotRutPayoutSetMatch(tx, [A, B, C], { maxSize: 2 })).toBeNull()
    expect(findRotRutPayoutSetMatch(tx, [A, B, C], { maxSize: 3 })).not.toBeNull()
  })
})

describe('matchTransactionsToRotRutPayoutSets', () => {
  it('pairs rows newest first and drains the pool so a begäran is offered once', () => {
    const rows = [
      makeTransaction({ id: 'tx-1', amount: 5250, date: '2026-07-12' }),
      makeTransaction({ id: 'tx-2', amount: 5250, date: '2026-07-10' }),
      makeTransaction({ id: 'tx-3', amount: 1200.5, date: '2026-07-09' }),
    ]
    const out = matchTransactionsToRotRutPayoutSets(rows, [A, B, C])
    expect([...out.keys()]).toEqual(['tx-1', 'tx-3'])
    expect(out.get('tx-1')?.requests.map((r) => r.id).sort()).toEqual(['rr-a', 'rr-b'])
    expect(out.get('tx-3')?.requests.map((r) => r.id)).toEqual(['rr-c'])
  })

  it('skips booked, reviewed and 1:1-hinted rows, and a hinted begäran leaves the pool', () => {
    const rows = [
      makeTransaction({ id: 'tx-booked', amount: 5250, journal_entry_id: 'je-9' }),
      makeTransaction({ id: 'tx-reviewed', amount: 5250, is_business: true }),
      makeTransaction({
        id: 'tx-hinted',
        amount: 3000,
        potential_rot_rut_payout_request_id: 'rr-a',
      }),
      makeTransaction({ id: 'tx-set', amount: 5250 }),
      makeTransaction({ id: 'tx-rest', amount: 3450.5 }),
    ]
    const out = matchTransactionsToRotRutPayoutSets(rows, [A, B, C])
    // A is claimed by the hint, so 5250 (A + B) cannot close; B + C = 3450.5 can.
    expect([...out.keys()]).toEqual(['tx-rest'])
    expect(out.get('tx-rest')?.requests.map((r) => r.id).sort()).toEqual(['rr-b', 'rr-c'])
  })

  it('returns an empty map without rows or requests', () => {
    expect(matchTransactionsToRotRutPayoutSets([], [A]).size).toBe(0)
    expect(matchTransactionsToRotRutPayoutSets([makeTransaction({ amount: 3000 })], []).size).toBe(0)
  })
})
