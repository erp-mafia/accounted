import { describe, expect, it } from 'vitest'
import { roundThousands } from '../thousand-kronor'

describe('roundThousands', () => {
  it.each([
    [0, 0],
    [1, 0],
    [499, 0],
    [500, 1],
    [501, 1],
    [1_499, 1],
    [1_500, 2],
    [2_650_400, 2_650],
    [2_650_500, 2_651],
    [999_499, 999],
    [999_500, 1_000],
    [123_456_789_500, 123_456_790],
  ])('states %i kr as %i tkr', (kronor, thousands) => {
    expect(roundThousands(kronor)).toBe(thousands)
  })

  it.each([
    [-499, 0],
    [-500, -1],
    [-1_499, -1],
    [-1_500, -2],
    [-4_684, -5],
    [-2_650_500, -2_651],
  ])('rounds a half away from zero on a negative figure: %i kr is %i tkr', (kronor, thousands) => {
    expect(roundThousands(kronor)).toBe(thousands)
  })

  it('never answers a negative zero', () => {
    expect(Object.is(roundThousands(-499), 0)).toBe(true)
    expect(Object.is(roundThousands(-0), 0)).toBe(true)
  })

  it('rounds the whole-krona figure the statements print, not the öre behind it', () => {
    // 499,50 kr prints as 500 kr in the statements, which is 1 tkr.
    expect(roundThousands(499.5)).toBe(1)
    expect(roundThousands(499.49)).toBe(0)
    expect(roundThousands(-499.5)).toBe(-1)
  })

  it('stays within 500 kr of the kronor figure, so both can be tagged', () => {
    for (const kronor of [0, 1, 499, 500, 501, 999, 1_000, 1_499, 1_500, 1_501, 73_500, 73_501, 9_999_500]) {
      for (const signed of [kronor, -kronor]) {
        expect(Math.abs(roundThousands(signed) * 1000 - signed)).toBeLessThanOrEqual(500)
      }
    }
  })
})
