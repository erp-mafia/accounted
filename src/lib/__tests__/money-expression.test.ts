import { describe, it, expect } from 'vitest'
import { parseAmountExpression, formatAmountValue } from '@/lib/money-expression'

describe('parseAmountExpression', () => {
  describe('plain numbers (drop-in for parseFloat)', () => {
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

describe('formatAmountValue', () => {
  it('writes an integer without decimals', () => {
    expect(formatAmountValue(1500)).toBe('1500')
  })

  it('writes a decimal with a point, matching what parseFloat consumers expect', () => {
    expect(formatAmountValue(1200.5)).toBe('1200.5')
  })

  it('rounds to the öre', () => {
    expect(formatAmountValue(3.333333)).toBe('3.33')
  })

  it('round-trips through parseAmountExpression', () => {
    const value = parseAmountExpression('1200,50+299,50')
    expect(value).not.toBeNull()
    expect(parseAmountExpression(formatAmountValue(value as number))).toBe(1500)
  })
})
