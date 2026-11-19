import { describe, expect, it } from 'vitest'
import { lineBalance, storedLineAmount } from '../line-balance'

const debit = (amount: number | string | null | undefined) => ({ debit_amount: amount })
const credit = (amount: number | string | null | undefined) => ({ credit_amount: amount })

describe('lineBalance', () => {
  it('balances when debits equal credits above zero', () => {
    expect(lineBalance([debit(100), credit(60), credit(40)])).toEqual({
      totalDebit: 100, totalCredit: 100, difference: 0, balanced: true,
    })
  })

  it('reports the difference with its sign', () => {
    expect(lineBalance([debit(100), credit(90.5)])).toMatchObject({ difference: 9.5, balanced: false })
    expect(lineBalance([debit(90.5), credit(100)])).toMatchObject({ difference: -9.5, balanced: false })
  })

  it('an empty entry has no difference and does not balance (hard rule 3)', () => {
    expect(lineBalance([])).toEqual({ totalDebit: 0, totalCredit: 0, difference: 0, balanced: false })
    expect(lineBalance([debit(0), credit(0)])).toMatchObject({ difference: 0, balanced: false })
  })

  it('sums without float drift', () => {
    expect(lineBalance([debit(0.1), debit(0.2), credit(0.3)])).toMatchObject({ totalDebit: 0.3, difference: 0, balanced: true })
    expect(lineBalance([debit(33.33), debit(33.33), debit(33.34), credit(100)]).balanced).toBe(true)
  })

  it('answers for the amounts the lines store, each line in whole öre', () => {
    // Raw sums balance; the engine stores 100,00 + 100,00 against 200,01.
    expect(lineBalance([debit(100.004), debit(100.004), credit(200.01)])).toMatchObject({
      totalDebit: 200, totalCredit: 200.01, difference: -0.01, balanced: false,
    })
    // Raw sums miss by a fifth of an öre; the stored amounts balance.
    expect(lineBalance([debit(100.004), debit(100.004), credit(200)]).balanced).toBe(true)
  })

  it('takes a half öre as roundOre does', () => {
    expect(lineBalance([debit(1.005), credit(1.01)]).balanced).toBe(true)
    expect(lineBalance([debit(1.005), credit(1)]).balanced).toBe(false)
  })

  it('reads a form\'s text amounts and treats an empty one as 0', () => {
    expect(lineBalance([
      { debit_amount: '125.50', credit_amount: '' },
      { debit_amount: '', credit_amount: '125.5' },
    ])).toMatchObject({ totalDebit: 125.5, totalCredit: 125.5, balanced: true })
  })

  it('treats a missing or unreadable amount as 0', () => {
    expect(lineBalance([debit(null), debit(undefined), debit('x'), debit(Number.NaN), debit(10), credit(10)]).balanced).toBe(true)
  })
})

describe('storedLineAmount', () => {
  it('is the amount to the öre, an exact half up', () => {
    expect(storedLineAmount(10.075)).toBe(10.08)
    expect(storedLineAmount(1.005)).toBe(1.01)
    expect(storedLineAmount('12.345')).toBe(12.35)
    expect(storedLineAmount(undefined)).toBe(0)
  })
})
