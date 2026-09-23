import { describe, it, expect } from 'vitest'
import { hasVoucherCandidate, type CandidateLine } from '../voucher-candidate'

/** A ledger line as the candidate RPCs project it: SEK columns, no FX. */
const line = (debit: number, credit: number): CandidateLine => ({
  debit_amount: debit,
  credit_amount: credit,
})

describe('hasVoucherCandidate', () => {
  it('matches money out against a credit of the same amount', () => {
    expect(hasVoucherCandidate(-1250, [line(0, 1250)], 'SEK')).toBe(true)
  })

  it('matches money in against a debit of the same amount', () => {
    expect(hasVoucherCandidate(1250, [line(1250, 0)], 'SEK')).toBe(true)
  })

  it('rejects a same-amount line on the wrong side', () => {
    // A credit cannot settle an incoming payment: the bank account is debited
    // when money arrives. Matching on amount alone would offer every voucher of
    // that size regardless of direction.
    expect(hasVoucherCandidate(1250, [line(0, 1250)], 'SEK')).toBe(false)
    expect(hasVoucherCandidate(-1250, [line(1250, 0)], 'SEK')).toBe(false)
  })

  it('requires equality to the öre', () => {
    expect(hasVoucherCandidate(-1250.5, [line(0, 1250.5)], 'SEK')).toBe(true)
    expect(hasVoucherCandidate(-1250.5, [line(0, 1250.49)], 'SEK')).toBe(false)
    expect(hasVoucherCandidate(-1250, [line(0, 1249.99)], 'SEK')).toBe(false)
  })

  it('compares as integer öre, so float noise cannot decide it', () => {
    // 0.1 + 0.2 is 0.30000000000000004; a raw === would say these differ.
    expect(hasVoucherCandidate(-(0.1 + 0.2), [line(0, 0.3)], 'SEK')).toBe(true)
  })

  it('handles PostgREST numeric strings on the ledger side', () => {
    expect(
      hasVoucherCandidate(-1250, [{ debit_amount: '0', credit_amount: '1250.00' }], 'SEK'),
    ).toBe(true)
  })

  it('finds a candidate anywhere in the list', () => {
    const lines = [line(0, 99), line(500, 0), line(0, 1250)]
    expect(hasVoucherCandidate(-1250, lines, 'SEK')).toBe(true)
  })

  it('returns false for an empty candidate list', () => {
    expect(hasVoucherCandidate(-1250, [], 'SEK')).toBe(false)
  })

  it('never claims a candidate on a foreign account whose lines carry no FX amount', () => {
    // get_account_gl_lines_for_matching projects neither currency nor
    // amount_in_currency, so on a EUR account no row can be expressed in EUR.
    // Reading the raw SEK columns would offer a 1 250 SEK leg as the settlement
    // for a 1 250 EUR bank line.
    expect(hasVoucherCandidate(-1250, [line(0, 1250)], 'EUR')).toBe(false)
  })

  it('matches a foreign line that DOES carry the amount in that currency', () => {
    expect(
      hasVoucherCandidate(
        -1250,
        [{ debit_amount: 0, credit_amount: 14375, currency: 'EUR', amount_in_currency: 1250 }],
        'EUR',
      ),
    ).toBe(true)
  })

  it('ignores a zero-amount row and zero-amount lines', () => {
    // A zero bank row is not a settlement question, and a zero ledger line
    // settles nothing: neither may produce a match on "amounts are equal".
    expect(hasVoucherCandidate(0, [line(0, 0)], 'SEK')).toBe(false)
    expect(hasVoucherCandidate(-1250, [line(0, 0)], 'SEK')).toBe(false)
  })
})
