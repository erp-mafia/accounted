/**
 * crm#1280: the "Belopp" a verifikat shows in the list. A bank payment of an
 * EU service read as the omslutning (bank line + fiktiv moms + the 4535/4598
 * basis pair), about twice the money that moved. The list now shows the money
 * line when the voucher records one movement through one money account, and
 * the omslutning otherwise.
 */
import { describe, it, expect } from 'vitest'
import { voucherDisplayAmount, type VoucherAmountLine } from '../voucher-display-amount'

type Line = [account: string, debit: number | string, credit: number | string]

function entry(lines: Line[], source_type = 'bank_transaction') {
  return {
    source_type,
    lines: lines.map(
      ([account_number, debit_amount, credit_amount]): VoucherAmountLine => ({
        account_number,
        debit_amount,
        credit_amount,
      }),
    ),
  }
}

/** A bank payment of an EU service, reverse charge at 25 %, gross method. */
const REVERSE_CHARGE_BANK_PAYMENT: Line[] = [
  ['2645', 50, 0], // fiktiv ingående moms
  ['2614', 0, 50], // fiktiv utgående moms
  ['4535', 200, 0], // basis, inköp tjänster annat EU-land
  ['4598', 0, 200], // motkonto basis
  ['6540', 200, 0],
  ['1930', 0, 200],
]

describe('voucherDisplayAmount', () => {
  it('shows the bank amount, not the omslutning, for a reverse-charge bank payment', () => {
    const result = voucherDisplayAmount(entry(REVERSE_CHARGE_BANK_PAYMENT))
    expect(result).toEqual({ amount: 200, debitTotal: 450, basis: 'money' })
  })

  it('shows the same amount for its storno (sides flipped)', () => {
    const storno = REVERSE_CHARGE_BANK_PAYMENT.map(([a, d, c]): Line => [a, c, d])
    expect(voucherDisplayAmount(entry(storno, 'storno'))).toEqual({
      amount: 200,
      debitTotal: 450,
      basis: 'money',
    })
  })

  it('a plain sale paid to the bank shows the bank amount, which equals the omslutning', () => {
    const result = voucherDisplayAmount(
      entry([
        ['1930', 1250, 0],
        ['3001', 0, 1000],
        ['2611', 0, 250],
      ]),
    )
    expect(result).toEqual({ amount: 1250, debitTotal: 1250, basis: 'money' })
  })

  it('a salary payment shows the net pay that left the bank', () => {
    const result = voucherDisplayAmount(
      entry(
        [
          ['7010', 30000, 0],
          ['7510', 9426, 0],
          ['2710', 0, 7000],
          ['2731', 0, 9426],
          ['1930', 0, 23000],
        ],
        'salary_payment',
      ),
    )
    expect(result).toEqual({ amount: 23000, debitTotal: 39426, basis: 'money' })
  })

  it('a card payout shows the net that reached the bank (receivable on the other side)', () => {
    const result = voucherDisplayAmount(
      entry([
        ['1930', 970, 0],
        ['6570', 30, 0],
        ['1580', 0, 1000],
      ]),
    )
    expect(result).toEqual({ amount: 970, debitTotal: 1000, basis: 'money' })
  })

  it('a manual multi-line voucher without a bank line falls back to the omslutning', () => {
    const result = voucherDisplayAmount(
      entry(
        [
          ['2645', 50, 0],
          ['2614', 0, 50],
          ['6540', 200, 0],
          ['2440', 0, 200],
        ],
        'manual',
      ),
    )
    expect(result).toEqual({ amount: 250, debitTotal: 250, basis: 'total' })
  })

  it('a voucher with two 19xx lines falls back to the omslutning', () => {
    const transfer = voucherDisplayAmount(
      entry([
        ['1940', 5000, 0],
        ['1930', 0, 5000],
      ]),
    )
    expect(transfer).toEqual({ amount: 5000, debitTotal: 5000, basis: 'total' })

    const split = voucherDisplayAmount(
      entry([
        ['1930', 600, 0],
        ['1910', 400, 0],
        ['3001', 0, 800],
        ['2611', 0, 200],
      ]),
    )
    expect(split).toEqual({ amount: 1000, debitTotal: 1000, basis: 'total' })
  })

  it('a split settlement (cash plus a card receivable on the same side) falls back', () => {
    const posDay = voucherDisplayAmount(
      entry(
        [
          ['1580', 9000, 0],
          ['1910', 1000, 0],
          ['3001', 0, 8000],
          ['2611', 0, 2000],
        ],
        'manual',
      ),
    )
    expect(posDay).toEqual({ amount: 10000, debitTotal: 10000, basis: 'total' })

    const rotCashPayment = voucherDisplayAmount(
      entry(
        [
          ['1513', 5000, 0],
          ['1930', 5000, 0],
          ['3001', 0, 8000],
          ['2611', 0, 2000],
        ],
        'invoice_cash_payment',
      ),
    )
    expect(rotCashPayment.basis).toBe('total')
    expect(rotCashPayment.amount).toBe(10000)

    const partlyFromSkattekonto = voucherDisplayAmount(
      entry(
        [
          ['2710', 7000, 0],
          ['2731', 9000, 0],
          ['1630', 0, 4000],
          ['1930', 0, 12000],
        ],
        'manual',
      ),
    )
    expect(partlyFromSkattekonto).toEqual({ amount: 16000, debitTotal: 16000, basis: 'total' })
  })

  it('an asset on the opposite side does not make it a split (a payment to the skattekonto)', () => {
    const result = voucherDisplayAmount(
      entry([
        ['1630', 16000, 0],
        ['1930', 0, 16000],
      ]),
    )
    expect(result).toEqual({ amount: 16000, debitTotal: 16000, basis: 'money' })
  })

  it('an opening-balance voucher shows the omslutning, never its bank balance', () => {
    const result = voucherDisplayAmount(
      entry(
        [
          ['1930', 40000, 0],
          ['1510', 10000, 0],
          ['2081', 0, 25000],
          ['2099', 0, 25000],
        ],
        'opening_balance',
      ),
    )
    expect(result).toEqual({ amount: 50000, debitTotal: 50000, basis: 'total' })
  })

  it('treats a cash account kept outside 19xx as a money account when it is passed in', () => {
    const lines: Line[] = [
      ['2645', 50, 0],
      ['2614', 0, 50],
      ['6540', 200, 0],
      ['1686', 0, 200],
    ]
    expect(voucherDisplayAmount(entry(lines)).basis).toBe('total')
    expect(voucherDisplayAmount(entry(lines), new Set(['1686']))).toEqual({
      amount: 200,
      debitTotal: 250,
      basis: 'money',
    })
  })

  it('a zero money line falls back to the omslutning', () => {
    const result = voucherDisplayAmount(
      entry(
        [
          ['1930', 0, 0],
          ['2013', 300, 0],
          ['3305', 0, 300],
        ],
        'correction',
      ),
    )
    expect(result).toEqual({ amount: 300, debitTotal: 300, basis: 'total' })
  })

  it('accepts PostgREST numeric strings and rounds to whole öre', () => {
    const result = voucherDisplayAmount(
      entry([
        ['2645', '0.1', '0'],
        ['2614', '0', '0.1'],
        ['6540', '0.2', '0'],
        ['1930', '0', '0.2'],
      ]),
    )
    expect(result).toEqual({ amount: 0.2, debitTotal: 0.3, basis: 'money' })
  })

  it('an entry without lines shows zero', () => {
    expect(voucherDisplayAmount({ source_type: 'manual', lines: [] })).toEqual({
      amount: 0,
      debitTotal: 0,
      basis: 'total',
    })
    expect(voucherDisplayAmount({ source_type: 'manual' })).toEqual({
      amount: 0,
      debitTotal: 0,
      basis: 'total',
    })
  })
})
