import { describe, it, expect } from 'vitest'
import {
  buildSupplierPaymentClearingLines,
  resolveSupplierCashSettlement,
  supplierOreResidual,
  supplierOreRoundingLine,
} from '@/lib/bookkeeping/supplier-payment-lines'
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

// #2852: one residual rule for the accrual clearing builder above and the
// kontantmetoden cash builder.
describe('supplierOreResidual', () => {
  it('is owed minus bank when the difference is a sub-krona residual', () => {
    expect(supplierOreResidual(1234.44, 1234)).toBe(0.44)
    expect(supplierOreResidual(1234.56, 1235)).toBe(-0.44)
  })

  it('is 0 for an exact settlement and for a difference of a krona or more', () => {
    expect(supplierOreResidual(1234.56, 1234.56)).toBe(0)
    expect(supplierOreResidual(1001, 1000)).toBe(0)
    expect(supplierOreResidual(1000, 1001)).toBe(0)
    expect(supplierOreResidual(1000.99, 1000)).toBe(0.99)
  })

  it('never reports float drift as a residual', () => {
    expect(supplierOreResidual(0.1 + 0.2, 0.3)).toBe(0)
  })
})

describe('supplierOreRoundingLine', () => {
  it('credits 3740 when the bank paid less than owed (vinst) and debits it when it paid more (förlust)', () => {
    expect(supplierOreRoundingLine(0.44)).toEqual({
      account_number: '3740',
      debit_amount: 0,
      credit_amount: 0.44,
      line_description: 'Öresavrundning',
    })
    expect(supplierOreRoundingLine(-0.44)).toEqual({
      account_number: '3740',
      debit_amount: 0.44,
      credit_amount: 0,
      line_description: 'Öresavrundning',
    })
  })
})

describe('resolveSupplierCashSettlement', () => {
  const rounded = { total: 1234.56, currency: 'SEK', ore_rounding: true }

  it('no bank row: settles at the whole-krona amount the user was told to pay when the invoice rounds', () => {
    expect(resolveSupplierCashSettlement({ invoice: rounded, owedSek: 1234.56 })).toEqual({
      bankSek: 1235,
      oreDiffSek: -0.44,
    })
    expect(
      resolveSupplierCashSettlement({
        invoice: { total: 1234.44, currency: 'SEK', ore_rounding: true },
        owedSek: 1234.44,
      }),
    ).toEqual({ bankSek: 1234, oreDiffSek: 0.44 })
  })

  it('no bank row: stays exact when the flag is off or null, the total is whole, or the currency is foreign', () => {
    for (const invoice of [
      { total: 1234.56, currency: 'SEK', ore_rounding: false },
      { total: 1234.56, currency: 'SEK', ore_rounding: null },
      { total: 1234.56, currency: 'SEK' },
    ]) {
      expect(resolveSupplierCashSettlement({ invoice, owedSek: 1234.56 })).toEqual({
        bankSek: 1234.56,
        oreDiffSek: 0,
      })
    }
    expect(
      resolveSupplierCashSettlement({
        invoice: { total: 1235, currency: 'SEK', ore_rounding: true },
        owedSek: 1235,
      }),
    ).toEqual({ bankSek: 1235, oreDiffSek: 0 })
    expect(
      resolveSupplierCashSettlement({
        invoice: { total: 100.5, currency: 'EUR', ore_rounding: true },
        owedSek: 1105.5,
      }),
    ).toEqual({ bankSek: 1105.5, oreDiffSek: 0 })
  })

  it('bank row known: the bank row decides, whatever the flag says', () => {
    // Flag off, whole-krona row: still öresavrundning, as on the accrual path.
    expect(
      resolveSupplierCashSettlement({
        invoice: { total: 1234.56, currency: 'SEK', ore_rounding: false },
        owedSek: 1234.56,
        knownBankSek: 1235,
      }),
    ).toEqual({ bankSek: 1235, oreDiffSek: -0.44 })
    // Flag on, but the bank row carries the exact öre: nothing to round.
    expect(
      resolveSupplierCashSettlement({ invoice: rounded, owedSek: 1234.56, knownBankSek: 1234.56 }),
    ).toEqual({ bankSek: 1234.56, oreDiffSek: 0 })
    // Rounded the "wrong" way by the payer: the row is still the truth.
    expect(
      resolveSupplierCashSettlement({ invoice: rounded, owedSek: 1234.56, knownBankSek: 1234 }),
    ).toEqual({ bankSek: 1234, oreDiffSek: 0.56 })
  })

  it('bank row known but a krona or more off: books the exact debt and never falls back to the flag', () => {
    expect(
      resolveSupplierCashSettlement({ invoice: rounded, owedSek: 1234.56, knownBankSek: 1300 }),
    ).toEqual({ bankSek: 1234.56, oreDiffSek: 0 })
  })

  it('never rounds a zero or negative net', () => {
    expect(
      resolveSupplierCashSettlement({
        invoice: { total: -10.5, currency: 'SEK', ore_rounding: true },
        owedSek: -10.5,
      }),
    ).toEqual({ bankSek: -10.5, oreDiffSek: 0 })
  })
})
