import { describe, it, expect } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import {
  expectedRotRutPayoutAmount,
  findRotRutPayoutMatch,
  getRotRutPayoutMatchTargetState,
  isMatchableRotRutPayoutRequest,
  mentionsSkatteverket,
  type RotRutPayoutRequestCandidate,
} from '../rot-rut-payout-matching'

function makeRequest(
  overrides: Partial<RotRutPayoutRequestCandidate> = {},
): RotRutPayoutRequestCandidate {
  return {
    id: 'rr-1',
    name: 'ROT 2026-07',
    deduction_type: 'rot',
    status: 'submitted',
    requested_total: 3000,
    decided_total: null,
    settlement_journal_entry_id: null,
    ...overrides,
  }
}

describe('expectedRotRutPayoutAmount', () => {
  it('prefers the recorded beslut over the requested total', () => {
    expect(expectedRotRutPayoutAmount(makeRequest())).toBe(3000)
    expect(expectedRotRutPayoutAmount(makeRequest({ decided_total: 2500 }))).toBe(2500)
  })

  it('coerces PostgREST NUMERIC strings', () => {
    expect(expectedRotRutPayoutAmount(makeRequest({ requested_total: '3000.00' }))).toBe(3000)
    expect(expectedRotRutPayoutAmount(makeRequest({ decided_total: '2499.995' }))).toBe(2500)
  })
})

describe('getRotRutPayoutMatchTargetState', () => {
  it('is matchable for open, unsettled requests', () => {
    for (const status of ['generated', 'submitted', 'partially_paid']) {
      expect(getRotRutPayoutMatchTargetState(makeRequest({ status }))).toBe('matchable')
    }
  })

  it('is settled once a settlement voucher exists or the request is paid', () => {
    expect(
      getRotRutPayoutMatchTargetState(makeRequest({ settlement_journal_entry_id: 'je-1' })),
    ).toBe('settled')
    expect(getRotRutPayoutMatchTargetState(makeRequest({ status: 'paid' }))).toBe('settled')
  })

  it('is not_open for cancelled, rejected or missing requests', () => {
    expect(getRotRutPayoutMatchTargetState(makeRequest({ status: 'cancelled' }))).toBe('not_open')
    expect(getRotRutPayoutMatchTargetState(makeRequest({ status: 'rejected' }))).toBe('not_open')
    expect(getRotRutPayoutMatchTargetState(null)).toBe('not_open')
    expect(isMatchableRotRutPayoutRequest(undefined)).toBe(false)
  })
})

describe('mentionsSkatteverket', () => {
  it('matches the agency name or the SKV abbreviation in description or merchant', () => {
    expect(mentionsSkatteverket({ amount: 1, description: 'Utbetalning SKATTEVERKET' })).toBe(true)
    expect(mentionsSkatteverket({ amount: 1, description: 'Ins. SKV rot' })).toBe(true)
    expect(mentionsSkatteverket({ amount: 1, merchant_name: 'Skatteverket' })).toBe(true)
    expect(mentionsSkatteverket({ amount: 1, description: 'Kund AB faktura 12' })).toBe(false)
    // "skvadron" must not count as SKV: the abbreviation needs word boundaries.
    expect(mentionsSkatteverket({ amount: 1, description: 'Skvadron AB' })).toBe(false)
  })
})

describe('findRotRutPayoutMatch', () => {
  it('returns null with no open requests', () => {
    expect(findRotRutPayoutMatch(makeTransaction({ amount: 3000 }), [])).toBeNull()
  })

  it('matches an exact-amount income row at 0.85', () => {
    const tx = makeTransaction({ amount: 3000, description: 'Insättning' })
    const match = findRotRutPayoutMatch(tx, [makeRequest()])
    expect(match).toEqual({ request: makeRequest(), confidence: 0.85, matchMethod: 'amount' })
  })

  it('boosts to 0.95 when Skatteverket is named', () => {
    const tx = makeTransaction({ amount: 3000, description: 'Skatteverket utbetalning' })
    const match = findRotRutPayoutMatch(tx, [makeRequest()])
    expect(match?.confidence).toBe(0.95)
    expect(match?.matchMethod).toBe('amount_skatteverket')
  })

  it('compares against the beslut amount when one is recorded', () => {
    const tx = makeTransaction({ amount: 2500, description: 'Skatteverket' })
    const request = makeRequest({ decided_total: 2500 })
    expect(findRotRutPayoutMatch(tx, [request])?.request.id).toBe('rr-1')
    expect(findRotRutPayoutMatch(makeTransaction({ amount: 3000 }), [request])).toBeNull()
  })

  it('never fuzzy-matches: an öre off is not this request', () => {
    const tx = makeTransaction({ amount: 3000.01, description: 'Skatteverket' })
    expect(findRotRutPayoutMatch(tx, [makeRequest()])).toBeNull()
  })

  it('ignores expenses, non-SEK rows and unmatchable requests', () => {
    expect(findRotRutPayoutMatch(makeTransaction({ amount: -3000 }), [makeRequest()])).toBeNull()
    expect(
      findRotRutPayoutMatch(makeTransaction({ amount: 3000, currency: 'EUR' as never }), [makeRequest()]),
    ).toBeNull()
    expect(
      findRotRutPayoutMatch(makeTransaction({ amount: 3000 }), [
        makeRequest({ settlement_journal_entry_id: 'je-1' }),
      ]),
    ).toBeNull()
    expect(
      findRotRutPayoutMatch(makeTransaction({ amount: 3000 }), [makeRequest({ status: 'cancelled' })]),
    ).toBeNull()
  })

  it('treats a NULL currency as SEK (legacy bank rows)', () => {
    const tx = makeTransaction({ amount: 3000, currency: null as never })
    expect(findRotRutPayoutMatch(tx, [makeRequest()])?.request.id).toBe('rr-1')
  })

  it('refuses to guess between two open requests with the same amount', () => {
    const tx = makeTransaction({ amount: 3000, description: 'Skatteverket' })
    const pool = [makeRequest({ id: 'rr-1' }), makeRequest({ id: 'rr-2', name: 'RUT 2026-07', deduction_type: 'rut' })]
    expect(findRotRutPayoutMatch(tx, pool)).toBeNull()
    // ...but picks the unique hit when the other differs in amount.
    const distinct = [makeRequest({ id: 'rr-1' }), makeRequest({ id: 'rr-2', requested_total: 4500 })]
    expect(findRotRutPayoutMatch(tx, distinct)?.request.id).toBe('rr-1')
  })
})
