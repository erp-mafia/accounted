import { describe, it, expect } from 'vitest'
import {
  movedOffCarry,
  overDisposedAmount,
  overMovedCarry,
  remainingCarry,
  resultAccountLeftover,
  resultAccountResidual,
} from '../prior-result-guard'

const row = (account_number: string, closing_debit: number, closing_credit: number) => ({
  account_number,
  closing_debit,
  closing_credit,
})

describe('resultAccountLeftover', () => {
  it('reports a prior profit still on 2099 before the close (PostHog PH 120)', () => {
    expect(resultAccountLeftover([row('1930', 50000, 0), row('2099', 0, 20000)], '2099')).toBe(20000)
  })

  it('reports a prior loss as a negative leftover', () => {
    expect(resultAccountLeftover([row('2099', 4000, 0)], '2099')).toBe(-4000)
  })

  it('is 0 when the result account is empty or absent', () => {
    expect(resultAccountLeftover([row('2099', 20000, 20000)], '2099')).toBe(0)
    expect(resultAccountLeftover([row('1930', 100, 0)], '2099')).toBe(0)
  })

  it('ignores öre-level noise', () => {
    expect(resultAccountLeftover([row('2069', 0, 0.004)], '2069')).toBe(0)
  })
})

describe('remainingCarry', () => {
  it('carries the whole IB when nothing was booked by hand', () => {
    expect(remainingCarry(30000, 0)).toBe(30000)
    expect(remainingCarry(-4000, 0)).toBe(-4000)
  })

  it('carries nothing when a hand booking moved it all (PostHog PH 108)', () => {
    expect(remainingCarry(30000, -30000)).toBe(0)
    expect(remainingCarry(-4000, 4000)).toBe(0)
  })

  it('carries only the rest after a partial hand booking', () => {
    expect(remainingCarry(30000, -10000)).toBe(20000)
    expect(remainingCarry(-4000, 1500)).toBe(-2500)
  })

  it('carries nothing when the hand booking moved more than was carried in', () => {
    expect(remainingCarry(30000, -45000)).toBe(0)
  })

  it('never carries more than the IB when a booking went the same direction', () => {
    expect(remainingCarry(30000, 5000)).toBe(30000)
  })

  it('carries nothing when there is no IB', () => {
    expect(remainingCarry(0, -5000)).toBe(0)
  })
})

describe('movedOffCarry', () => {
  const entry = (
    sourceType: string,
    voucher: string,
    lines: Array<[string, number, number]>,
  ) => ({
    sourceType,
    voucher,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })

  it('counts the automatic omföring', () => {
    const moved = movedOffCarry(
      [entry('result_appropriation', 'A2', [['2099', 20000, 0], ['2098', 0, 20000]])],
      '2099',
      ['2098', '2091'],
      20000,
    )
    expect(moved).toEqual({ net: -20000, vouchers: ['A2'] })
  })

  it('counts only the lines against the carry in a hand-booked disposition (PostHog PH 108)', () => {
    const moved = movedOffCarry(
      [
        entry('manual', 'A12', [
          ['2067', 0, 30000],
          ['2069', 30000, 0],
          ['2069', 0, 12000],
          ['2099', 12000, 0],
        ]),
      ],
      '2069',
      ['2068', '2067'],
      30000,
    )
    expect(moved).toEqual({ net: -30000, vouchers: ['A12'] })
  })

  it('ignores a storno, the opening balance and the closing entry', () => {
    const moved = movedOffCarry(
      [
        entry('storno', 'A16', [['2069', 0, 30000], ['2068', 30000, 0]]),
        entry('opening_balance', 'A10', [['2069', 0, 30000]]),
        entry('year_end', 'A14', [['2069', 0, 12000]]),
      ],
      '2069',
      ['2068', '2067'],
      30000,
    )
    expect(moved).toEqual({ net: 0, vouchers: [] })
  })

  it('does not count a 2099 booking that moves nothing to a disposition account', () => {
    const moved = movedOffCarry([entry('manual', 'A11', [['2099', 20000, 0], ['8999', 0, 20000]])], '2099', ['2098', '2091'], 20000)
    expect(moved).toEqual({ net: 0, vouchers: [] })
  })

  it('counts credits against a carried loss', () => {
    const moved = movedOffCarry([entry('manual', 'A5', [['2099', 0, 4000], ['2091', 4000, 0]])], '2099', ['2098', '2091'], -4000)
    expect(moved).toEqual({ net: 4000, vouchers: ['A5'] })
  })
})

// A migrated aktiebolag's FY2022 (prod, read 2026-09-29): 2021's result came in as
// IB 2099 C 151 986,05 and was moved off twice, by the automatic omföring
// (A181) and by the previous system's own disposition imported into the same
// year (A176, plus 2 kr in A178). A177/A178 also close 2022's result onto
// 2099 by hand through 8999 (net 1 962,87), and A178 mixes a 94 kr closing
// line with its 2 kr disposition.
describe('over-disposed prior result', () => {
  const entry = (sourceType: string, voucher: string, lines: Array<[string, number, number]>) => ({
    sourceType,
    voucher,
    lines: lines.map(([account_number, debit_amount, credit_amount]) => ({ account_number, debit_amount, credit_amount })),
  })
  const FY2022 = [
    entry('result_appropriation', 'A181', [['2099', 151986.05, 0], ['2098', 0, 151986.05]]),
    entry('import', 'A176', [['2091', 0, 151178.05], ['2099', 151178.05, 0]]),
    entry('import', 'A177', [['2099', 0, 2056.87]]),
    entry('import', 'A178', [['2091', 0, 2], ['2099', 2, 0], ['2099', 94, 0]]),
  ]
  const TB_2022 = [row('2099', 149217.18, 0), row('8999', 2056.87, 94)]

  describe('overMovedCarry', () => {
    it('is 0 while the dispositions moved at most what was carried in', () => {
      expect(overMovedCarry(30000, -30000)).toBe(0)
      expect(overMovedCarry(30000, -10000)).toBe(0)
      expect(overMovedCarry(30000, 5000)).toBe(0)
      expect(overMovedCarry(0, -5000)).toBe(0)
    })

    it('reports what was moved beyond the carry, with the opposite sign', () => {
      expect(overMovedCarry(151986.05, -303260.1)).toBe(-151274.05)
      expect(overMovedCarry(-4000, 9000)).toBe(5000)
    })
  })

  describe('resultAccountResidual', () => {
    it('leaves out this year\'s result closed onto the account through 8999', () => {
      expect(resultAccountResidual(TB_2022, '2099')).toBe(-151180.05)
    })

    it('is 0 when the account holds exactly this year\'s hand-closed result', () => {
      expect(resultAccountResidual([row('2069', 12000, 0), row('8999', 0, 12000)], '2069')).toBe(0)
      expect(resultAccountResidual([row('2099', 0, 1962.87), row('8999', 1962.87, 0)], '2099')).toBe(0)
    })

    it('is the plain balance when nothing was closed by hand', () => {
      expect(resultAccountResidual([row('2099', 0, 20000), row('1930', 20000, 0)], '2099')).toBe(20000)
      expect(resultAccountResidual([row('1930', 100, 0)], '2099')).toBe(0)
    })
  })

  describe('overDisposedAmount', () => {
    it('is the smaller of the over-moved carry and the residual', () => {
      expect(overDisposedAmount(-151274.05, -151180.05)).toBe(-151180.05)
      expect(overDisposedAmount(-5000, -8000)).toBe(-5000)
      expect(overDisposedAmount(4000, 2500)).toBe(2500)
    })

    it('is 0 once a correction entry cleared the residual', () => {
      expect(overDisposedAmount(-151274.05, 0)).toBe(0)
    })

    it('is 0 when nothing was over-moved or the residual has the carry\'s sign', () => {
      expect(overDisposedAmount(0, -5000)).toBe(0)
      expect(overDisposedAmount(-12000, 5000)).toBe(0)
    })
  })

  it('measures the migrated aktiebolag end to end: 151 180,05 moved off too much, not the raw 149 217,18', () => {
    const moved = movedOffCarry(FY2022, '2099', ['2098', '2091'], 151986.05)
    expect(moved.vouchers).toEqual(['A181', 'A176', 'A178'])
    // #3153's omföring guard: nothing left to carry, so no third transfer.
    expect(remainingCarry(151986.05, moved.net)).toBe(0)
    const excess = overDisposedAmount(
      overMovedCarry(151986.05, moved.net),
      resultAccountResidual(TB_2022, '2099'),
    )
    expect(excess).toBe(-151180.05)
    expect(resultAccountLeftover(TB_2022, '2099')).toBe(-149217.18)
  })

  it('clears once a correction entry moves the excess back (Dr 2091 / Cr 2099)', () => {
    // The correction credits 2099 in the carry's direction, which movedOffCarry
    // does not count: the residual is what clears.
    const moved = movedOffCarry(
      [...FY2022, entry('manual', 'A190', [['2091', 151180.05, 0], ['2099', 0, 151180.05]])],
      '2099',
      ['2098', '2091'],
      151986.05,
    )
    const corrected = [row('2099', 149217.18, 151180.05), row('8999', 2056.87, 94)]
    expect(overMovedCarry(151986.05, moved.net)).toBe(-151274.05)
    expect(overDisposedAmount(overMovedCarry(151986.05, moved.net), resultAccountResidual(corrected, '2099'))).toBe(0)
  })

  it('does not flag this year\'s loss re-homed in the disposition verifikat (PostHog PH 108 shape)', () => {
    // Dr 2069 30 000 disposes last year's profit; Dr 2069 12 000 re-homes this
    // year's loss (closed by hand: Cr 8999 12 000). Both count as moved.
    const moved = movedOffCarry(
      [entry('manual', 'A12', [['2067', 0, 30000], ['2069', 30000, 0], ['2069', 12000, 0]])],
      '2069',
      ['2068', '2067'],
      30000,
    )
    expect(overMovedCarry(30000, moved.net)).toBe(-12000)
    const tb = [row('2069', 12000, 0), row('8999', 0, 12000)]
    expect(overDisposedAmount(overMovedCarry(30000, moved.net), resultAccountResidual(tb, '2069'))).toBe(0)
  })
})
