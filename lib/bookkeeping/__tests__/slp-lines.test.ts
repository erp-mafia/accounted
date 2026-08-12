import { describe, it, expect } from 'vitest'
import { SLP_RATE, generateSlpLines, isSlpPensionAccount } from '../slp-lines'

describe('SLP_RATE', () => {
  it('is the statutory 24.26 % (SLF 1991:687)', () => {
    expect(SLP_RATE).toBe(0.2426)
  })
})

describe('isSlpPensionAccount', () => {
  it('accepts the whole 7410-7419 range', () => {
    for (let i = 0; i <= 9; i++) {
      expect(isSlpPensionAccount(`741${i}`)).toBe(true)
    }
  })

  it('rejects everything outside the range', () => {
    for (const account of ['7400', '7420', '7533', '2514', '6200', '741', '74100', '']) {
      expect(isSlpPensionAccount(account)).toBe(false)
    }
  })
})

describe('generateSlpLines', () => {
  it('builds the 7533 D / 2514 K pair at 24.26 % (Avanza case: 10 000 kr premie)', () => {
    const lines = generateSlpLines(10000)
    expect(lines).toHaveLength(2)

    const [debit, credit] = lines
    expect(debit.account_number).toBe('7533')
    expect(debit.debit_amount).toBe(2426)
    expect(debit.credit_amount).toBe(0)

    expect(credit.account_number).toBe('2514')
    expect(credit.credit_amount).toBe(2426)
    expect(credit.debit_amount).toBe(0)

    expect(debit.line_description).toBe('Särskild löneskatt på pensionskostnader (24,26 %)')
  })

  it('nets to zero (never moves the payable)', () => {
    const lines = generateSlpLines(1234.56)
    const debits = lines.reduce((s, l) => s + l.debit_amount, 0)
    const credits = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(debits).toBe(credits)
    expect(debits).toBeGreaterThan(0)
  })

  it('rounds to öre with Math.round semantics', () => {
    // 1000.01 × 0.2426 = 242.602426 → 242.60
    const lines = generateSlpLines(1000.01)
    expect(lines[0].debit_amount).toBe(242.6)
    // 103 × 0.2426 = 24.9878 → 24.99
    expect(generateSlpLines(103)[0].debit_amount).toBe(24.99)
  })

  it('returns [] for zero and negative bases', () => {
    expect(generateSlpLines(0)).toEqual([])
    expect(generateSlpLines(-5000)).toEqual([])
  })

  it('returns [] when rounding produces a zero amount', () => {
    // 0.01 × 0.2426 = 0.002426 → rounds to 0.00: no zero-amount lines, the
    // engine requires every posted line amount > 0 on one side.
    expect(generateSlpLines(0.01)).toEqual([])
  })
})
