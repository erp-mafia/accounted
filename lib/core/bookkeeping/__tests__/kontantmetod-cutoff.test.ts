import { describe, it, expect } from 'vitest'
import {
  buildCutoffLines,
  distributeOre,
  nextDay,
  reverseLines,
  VILANDE_INPUT_VAT_ACCOUNT,
  VILANDE_OUTPUT_VAT_ACCOUNTS,
} from '../kontantmetod-cutoff'
import type { CutoffPayable, CutoffReceivable } from '../kontantmetod-cutoff'
import { roundOre } from '@/lib/money'

const sum = (lines: Array<{ debit_amount: number; credit_amount: number }>) => ({
  debit: roundOre(lines.reduce((s, l) => s + l.debit_amount, 0)),
  credit: roundOre(lines.reduce((s, l) => s + l.credit_amount, 0)),
})

const receivable = (over: Partial<CutoffReceivable> = {}): CutoffReceivable => ({
  id: 'inv-1',
  reference: 'F-1',
  vatTreatment: 'standard_25',
  outstanding: 1250,
  vat: 250,
  ...over,
})

const payable = (over: Partial<CutoffPayable> = {}): CutoffPayable => ({
  id: 'si-1',
  reference: 'L-1',
  outstanding: 1250,
  vat: 250,
  netByAccount: [{ account: '5410', amount: 1000 }],
  ...over,
})

describe('distributeOre', () => {
  it('splits exactly, with no öre lost or invented', () => {
    // 100 öre over three equal buckets cannot divide evenly: the largest
    // remainders must absorb the leftovers rather than the total drifting.
    const parts = distributeOre(100, [1, 1, 1])
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100)
    expect(parts).toEqual([34, 33, 33])
  })

  it('weights proportionally', () => {
    expect(distributeOre(1000, [3, 1])).toEqual([750, 250])
  })

  it('handles degenerate input without emitting NaN', () => {
    expect(distributeOre(500, [0, 0])).toEqual([500, 0])
    expect(distributeOre(500, [])).toEqual([])
    expect(distributeOre(500, [7])).toEqual([500])
  })
})

describe('buildCutoffLines: fordringar', () => {
  it('books the receivable against revenue and VILANDE output moms', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])

    const debit = receivableLines.find((l) => l.debit_amount > 0)
    expect(debit?.account_number).toBe('1510')
    expect(debit?.debit_amount).toBe(1250)

    // The whole point: moms parks on 2618, NOT 2611, so it stays out of the
    // momsdeklaration until the invoice is actually paid.
    const vatLine = receivableLines.find((l) => l.account_number === '2618')
    expect(vatLine?.credit_amount).toBe(250)
    expect(receivableLines.some((l) => l.account_number === '2611')).toBe(false)

    expect(receivableLines.find((l) => l.account_number === '3001')?.credit_amount).toBe(1000)
  })

  it('balances', () => {
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'a', outstanding: 1250, vat: 250 }),
        receivable({ id: 'b', outstanding: 560, vat: 60, vatTreatment: 'reduced_12' }),
        receivable({ id: 'c', outstanding: 106, vat: 6, vatTreatment: 'reduced_6' }),
      ],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.debit).toBe(1916)
  })

  it('balances on amounts that do not divide evenly', () => {
    // 33.33 % style residue: net is derived as outstanding - vat precisely so
    // the two legs always add back to the receivable.
    const { receivableLines } = buildCutoffLines(
      [receivable({ outstanding: 1000.01, vat: 200.003 })],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('uses one vilande account per rate', () => {
    const { receivableLines } = buildCutoffLines(
      [
        receivable({ id: 'a', vatTreatment: 'standard_25' }),
        receivable({ id: 'b', outstanding: 1120, vat: 120, vatTreatment: 'reduced_12' }),
      ],
      [],
    )
    expect(receivableLines.find((l) => l.account_number === VILANDE_OUTPUT_VAT_ACCOUNTS.standard_25)).toBeDefined()
    expect(receivableLines.find((l) => l.account_number === VILANDE_OUTPUT_VAT_ACCOUNTS.reduced_12)).toBeDefined()
  })

  it('treats a zero-moms treatment as pure revenue', () => {
    // Export carries no Swedish output moms, so nothing may land on a vilande
    // account: the full outstanding is revenue.
    const { receivableLines } = buildCutoffLines(
      [receivable({ vatTreatment: 'export', outstanding: 5000, vat: 0 })],
      [],
    )
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expect(receivableLines.find((l) => l.account_number === '3305')?.credit_amount).toBe(5000)
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
  })

  it('still balances when a zero-moms treatment carries a stray moms amount', () => {
    // Data error: export with moms. It must not invent a moms account, and
    // above all must not unbalance the verifikat.
    const { receivableLines } = buildCutoffLines(
      [receivable({ vatTreatment: 'export', outstanding: 5000, vat: 100 })],
      [],
    )
    const totals = sum(receivableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(receivableLines.some((l) => l.account_number.startsWith('26'))).toBe(false)
  })

  it('emits nothing when there is nothing outstanding', () => {
    expect(buildCutoffLines([], []).receivableLines).toEqual([])
    expect(buildCutoffLines([receivable({ outstanding: 0, vat: 0 })], []).receivableLines).toEqual([])
  })
})

describe('buildCutoffLines: skulder', () => {
  it('books the payable against expense and VILANDE input moms', () => {
    const { payableLines } = buildCutoffLines([], [payable()])

    const credit = payableLines.find((l) => l.credit_amount > 0)
    expect(credit?.account_number).toBe('2440')
    expect(credit?.credit_amount).toBe(1250)

    // 2648, not 2641: the deduction is not claimable until payment.
    expect(payableLines.find((l) => l.account_number === VILANDE_INPUT_VAT_ACCOUNT)?.debit_amount).toBe(250)
    expect(payableLines.some((l) => l.account_number === '2641')).toBe(false)

    expect(payableLines.find((l) => l.account_number === '5410')?.debit_amount).toBe(1000)
  })

  it('splits the net across several expense accounts and still balances', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [
        payable({
          outstanding: 1250,
          vat: 250,
          netByAccount: [
            { account: '5410', amount: 700 },
            { account: '6110', amount: 300 },
          ],
        }),
      ],
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(payableLines.find((l) => l.account_number === '5410')?.debit_amount).toBe(700)
    expect(payableLines.find((l) => l.account_number === '6110')?.debit_amount).toBe(300)
  })

  it('balances when the account split cannot divide evenly', () => {
    const { payableLines } = buildCutoffLines(
      [],
      [
        payable({
          outstanding: 100.01,
          vat: 0,
          netByAccount: [
            { account: '5410', amount: 1 },
            { account: '6110', amount: 1 },
            { account: '6210', amount: 1 },
          ],
        }),
      ],
    )
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
    expect(totals.credit).toBe(100.01)
  })

  it('falls back to a generic expense account when item detail is missing', () => {
    const { payableLines } = buildCutoffLines([], [payable({ netByAccount: [] })])
    expect(payableLines.find((l) => l.account_number === '6990')?.debit_amount).toBe(1000)
    const totals = sum(payableLines)
    expect(totals.debit).toBe(totals.credit)
  })
})

describe('reverseLines', () => {
  it('swaps every debit and credit so the vändning nets to zero', () => {
    const { receivableLines } = buildCutoffLines([receivable()], [])
    const reversed = reverseLines(receivableLines)

    const original = sum(receivableLines)
    const back = sum(reversed)
    expect(back.debit).toBe(original.credit)
    expect(back.credit).toBe(original.debit)

    // Net effect of cut-off + vändning on 1510 is exactly zero.
    const net = [...receivableLines, ...reversed]
      .filter((l) => l.account_number === '1510')
      .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0)
    expect(net).toBe(0)
  })

  it('labels the reversal so the verifikat is self-explanatory', () => {
    expect(reverseLines([{ account_number: '1510', debit_amount: 10, credit_amount: 0, line_description: 'X' }])[0]
      .line_description).toBe('Vändning: X')
  })
})

describe('nextDay', () => {
  it('rolls over year end', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
  })

  it('handles a broken fiscal year and a leap day', () => {
    expect(nextDay('2026-06-30')).toBe('2026-07-01')
    expect(nextDay('2028-02-28')).toBe('2028-02-29')
  })
})
