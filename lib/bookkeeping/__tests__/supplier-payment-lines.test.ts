import { describe, it, expect } from 'vitest'
import { buildSupplierPaymentClearingLines } from '@/lib/bookkeeping/supplier-payment-lines'
import { sumOre } from '@/lib/money'

function sumDebit(lines: Array<{ debit_amount: number }>): number {
  return sumOre(lines.map((l) => l.debit_amount))
}
function sumCredit(lines: Array<{ credit_amount: number }>): number {
  return sumOre(lines.map((l) => l.credit_amount))
}
function line(lines: Array<{ account_number: string }>, acct: string) {
  return lines.find((l) => l.account_number === acct)
}

describe('buildSupplierPaymentClearingLines', () => {
  it('books the öre residual to 3740 (credit) when the bank paid a sub-krona LESS: the reported 11 231,25 / 11 231,00 case', () => {
    const { lines, oreDiffSek } = buildSupplierPaymentClearingLines({
      apSek: 11231.25,
      bankSek: 11231,
      paymentAccount: '1930',
    })
    expect(oreDiffSek).toBe(0.25)
    // 2440 cleared in FULL so the invoice settles; bank leg = actual SEK paid.
    expect(line(lines, '2440')?.debit_amount).toBe(11231.25)
    expect(line(lines, '1930')?.credit_amount).toBe(11231)
    expect(line(lines, '3740')?.credit_amount).toBe(0.25)
    expect(line(lines, '3740')?.debit_amount).toBe(0)
    // Balances to the öre.
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('books the öre residual to 3740 (debit) when the bank paid a sub-krona MORE', () => {
    const { lines, oreDiffSek } = buildSupplierPaymentClearingLines({
      apSek: 11231,
      bankSek: 11231.25,
      paymentAccount: '1930',
    })
    expect(oreDiffSek).toBe(-0.25)
    expect(line(lines, '2440')?.debit_amount).toBe(11231)
    expect(line(lines, '1930')?.credit_amount).toBe(11231.25)
    expect(line(lines, '3740')?.debit_amount).toBe(0.25)
    expect(sumDebit(lines)).toBe(sumCredit(lines))
  })

  it('emits no 3740 line for an exact settlement', () => {
    const { lines, oreDiffSek } = buildSupplierPaymentClearingLines({
      apSek: 2390,
      bankSek: 2390,
      paymentAccount: '1930',
    })
    expect(oreDiffSek).toBe(0)
    expect(lines).toHaveLength(2)
    expect(line(lines, '3740')).toBeUndefined()
    expect(line(lines, '2440')?.debit_amount).toBe(2390)
    expect(line(lines, '1930')?.credit_amount).toBe(2390)
  })

  it('treats a ≥1 kr shortfall as a genuine partial: clamps to the bank amount, no 3740', () => {
    const { lines, oreDiffSek } = buildSupplierPaymentClearingLines({
      apSek: 11231.25,
      bankSek: 5000,
      paymentAccount: '1930',
    })
    expect(oreDiffSek).toBe(0)
    expect(lines).toHaveLength(2)
    expect(line(lines, '3740')).toBeUndefined()
    // Only what actually moved clears 2440: the remainder stays a partial.
    expect(line(lines, '2440')?.debit_amount).toBe(5000)
    expect(line(lines, '1930')?.credit_amount).toBe(5000)
  })

  it('honours the 1 kr band boundary: 0,99 absorbs, exactly 1,00 does not', () => {
    const absorbed = buildSupplierPaymentClearingLines({ apSek: 1000.99, bankSek: 1000, paymentAccount: '1930' })
    expect(absorbed.oreDiffSek).toBe(0.99)
    expect(line(absorbed.lines, '3740')?.credit_amount).toBe(0.99)

    const notAbsorbed = buildSupplierPaymentClearingLines({ apSek: 1001, bankSek: 1000, paymentAccount: '1930' })
    expect(notAbsorbed.oreDiffSek).toBe(0)
    expect(line(notAbsorbed.lines, '3740')).toBeUndefined()
    expect(line(notAbsorbed.lines, '2440')?.debit_amount).toBe(1000) // clamped
  })

  it('credits the chosen payment account, not a hardcoded 1930', () => {
    const { lines } = buildSupplierPaymentClearingLines({ apSek: 500, bankSek: 500, paymentAccount: '1932' })
    expect(line(lines, '1932')?.credit_amount).toBe(500)
    expect(line(lines, '1930')).toBeUndefined()
  })
})
