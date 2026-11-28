import { describe, it, expect } from 'vitest'
import { parseAmountExpression } from '@/lib/money-expression'
import { formatAmountInput, parseAmountInput, roundOre } from '@/lib/money'

describe('parseAmountExpression', () => {
  describe('plain numbers', () => {
    it('reads an integer', () => {
      expect(parseAmountExpression('1200')).toBe(1200)
    })

    it('reads a point decimal', () => {
      expect(parseAmountExpression('1200.50')).toBe(1200.5)
    })

    it('reads a Swedish decimal comma', () => {
      expect(parseAmountExpression('1200,50')).toBe(1200.5)
    })

    it('treats spaces as thousands separators', () => {
      expect(parseAmountExpression('1 200,50')).toBe(1200.5)
      expect(parseAmountExpression('1 200,50')).toBe(1200.5)
      expect(parseAmountExpression('1 200,50')).toBe(1200.5)
    })

    it('reads zero', () => {
      expect(parseAmountExpression('0')).toBe(0)
    })
  })

  describe('arithmetic', () => {
    it('adds', () => {
      expect(parseAmountExpression('1200+300')).toBe(1500)
    })

    it('subtracts', () => {
      expect(parseAmountExpression('1500-300')).toBe(1200)
    })

    it('multiplies, the moms case', () => {
      expect(parseAmountExpression('4500*0.25')).toBe(1125)
    })

    it('divides, the cost-split case', () => {
      expect(parseAmountExpression('12500/4')).toBe(3125)
    })

    it('honours precedence', () => {
      expect(parseAmountExpression('100+10*2')).toBe(120)
    })

    it('honours parentheses', () => {
      expect(parseAmountExpression('(100+10)*2')).toBe(220)
    })

    it('nests parentheses', () => {
      expect(parseAmountExpression('((100+10)*2)-20')).toBe(200)
    })

    it('chains several terms', () => {
      expect(parseAmountExpression('100+200+300-50')).toBe(550)
    })

    it('ignores spaces around operators', () => {
      expect(parseAmountExpression('1 200 + 300')).toBe(1500)
    })

    it('mixes comma decimals into arithmetic', () => {
      expect(parseAmountExpression('1200,50+299,50')).toBe(1500)
    })

    it('applies a unary minus', () => {
      expect(parseAmountExpression('-100')).toBe(-100)
      expect(parseAmountExpression('100*-2')).toBe(-200)
    })
  })

  describe('rounding', () => {
    it('rounds the result to the öre', () => {
      expect(parseAmountExpression('10/3')).toBe(3.33)
    })

    it('rounds a moms split to the öre', () => {
      expect(parseAmountExpression('1234,56*0,25')).toBe(308.64)
    })

    it('does not accumulate float drift across additions', () => {
      expect(parseAmountExpression('0,1+0,2')).toBe(0.3)
    })
  })

  describe('invalid input returns null, never zero', () => {
    it.each([
      ['', 'empty'],
      ['   ', 'whitespace only'],
      ['abc', 'letters'],
      ['1200+', 'dangling operator'],
      ['+', 'lone operator'],
      ['(1200+300', 'unclosed paren'],
      ['1200+300)', 'unopened paren'],
      ['()', 'empty parens'],
      ['1200/0', 'division by zero'],
      ['1.2.3', 'two decimal separators'],
      ['1,2,3', 'two decimal commas'],
      ['1200;300', 'unrecognised character'],
      ['2**10', 'exponentiation is not supported'],
    ])('rejects %s (%s)', (input) => {
      expect(parseAmountExpression(input)).toBeNull()
    })
  })

  describe('documented consequences of the two lenient rules', () => {
    // Spaces group thousands, so a space between two numbers joins them rather
    // than being an error. Pasting a formatted "1 234,00" is common and must
    // work; "1200 300" as a way of writing 1500 is not a thing anyone types.
    it('joins digits across a space instead of rejecting', () => {
      expect(parseAmountExpression('1200 300')).toBe(1200300)
    })

    // A second sign is unary, exactly as in every other calculator and language:
    // 1200 + (+300). Not a typo worth rejecting.
    it('reads a doubled sign as a unary sign', () => {
      expect(parseAmountExpression('1200++300')).toBe(1500)
      expect(parseAmountExpression('1200--300')).toBe(1500)
      expect(parseAmountExpression('1200+-300')).toBe(900)
    })
  })
})

describe('exact decimals: one rounding, on the exact result', () => {
  // As float products these land just below the half öre and round down.
  it.each([
    ['2,75*0,06', 0.17],
    ['0,42/1,12', 0.38],
    ['33,33*11,5', 383.3],
    ['1,005', 1.01],
    ['0,005+0,005+0,005', 0.02],
  ])('%s is %s', (input, expected) => {
    expect(parseAmountExpression(input)).toBe(expected)
  })

  it('rounds a negative half öre as roundOre does', () => {
    expect(parseAmountExpression('-1,005')).toBe(roundOre(-1.005))
    expect(parseAmountExpression('0-1,005')).toBe(roundOre(-1.005))
  })

  it('refuses a division by a sum that is exactly zero', () => {
    expect(parseAmountExpression('1/(0,1+0,2-0,3)')).toBeNull()
  })

  it('answers 0, never -0', () => {
    expect(Object.is(parseAmountExpression('-0'), 0)).toBe(true)
    expect(Object.is(parseAmountExpression('0*-1'), 0)).toBe(true)
    expect(Object.is(parseAmountExpression('-0,001'), 0)).toBe(true)
  })

  it('reads U+2212 as a minus inside a sum', () => {
    expect(parseAmountExpression('1200\u2212300')).toBe(900)
  })

  it('answers null, without throwing, past 100 levels of nesting', () => {
    expect(parseAmountExpression('('.repeat(100) + '1' + ')'.repeat(100))).toBe(1)
    expect(parseAmountExpression('('.repeat(20000) + '1' + ')'.repeat(20000))).toBeNull()
    expect(parseAmountExpression('-'.repeat(20000) + '1')).toBeNull()
  })
})

describe('a plain amount means what it means to parseAmountInput', () => {
  it.each(['1200', '1200,50', '1200.50', '1 234,50', '1.234,50', '1,234.50', '-500', '\u2212500', '0,5'])(
    'reads %s as parseAmountInput does',
    (input) => {
      expect(parseAmountExpression(input)).toBe(parseAmountInput(input))
    },
  )

  it('reads a grouped literal inside a sum', () => {
    expect(parseAmountExpression('1.234,50+765,50')).toBe(2000)
  })

  it('round-trips the written-back text (formatAmountInput)', () => {
    const value = parseAmountExpression('1200,50+299,25')
    expect(value).toBe(1499.75)
    expect(formatAmountInput(value as number)).toBe('1499,75')
    expect(parseAmountExpression(formatAmountInput(value as number))).toBe(1499.75)
  })
})
