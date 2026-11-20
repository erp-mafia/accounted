import { describe, expect, it } from 'vitest'
import {
  MAX_PAYOUT_FEES,
  PAYOUT_FEE_DEFAULT_DESCRIPTION,
  PAYOUT_FEE_DESCRIPTION_MAX,
  isPayoutFeeAccount,
  payoutBankAmount,
  payoutFeeLines,
  payoutFeeTotal,
  payoutFeesWithinInvoices,
} from '../payout-fee-lines'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'

describe('isPayoutFeeAccount', () => {
  it('takes the class 6 fee accounts: bank, card and factoring fees', () => {
    for (const account of ['6570', '6040', '6064', '6590']) expect(isPayoutFeeAccount(account)).toBe(true)
  })

  it('refuses every other class, a short or long number and a number given as a number', () => {
    for (const account of ['1930', '3001', '4538', '5010', '7960', '8410', '657', '65700', '']) {
      expect(isPayoutFeeAccount(account)).toBe(false)
    }
    expect(isPayoutFeeAccount(6570 as unknown as string)).toBe(false)
  })

  it('no account a momsdeklaration ruta reads can take a fee: the fee carries no VAT', () => {
    expect(Object.keys(VAT_ACCOUNT_TABLE).filter(isPayoutFeeAccount)).toEqual([])
  })
})

describe('payoutFeeLines', () => {
  it('rounds to the öre, trims the text and falls back to the single-invoice fee text', () => {
    expect(
      payoutFeeLines([
        { account: '6570', amount: 1500.004, description: '  Stripe juni  ' },
        { account: '6040', amount: 29.995 },
        { account: '6570', amount: 10, description: '   ' },
        { account: '6570', amount: 1, description: null },
      ]),
    ).toEqual([
      { account: '6570', amount: 1500, description: 'Stripe juni' },
      { account: '6040', amount: 30, description: PAYOUT_FEE_DEFAULT_DESCRIPTION },
      { account: '6570', amount: 10, description: PAYOUT_FEE_DEFAULT_DESCRIPTION },
      { account: '6570', amount: 1, description: PAYOUT_FEE_DEFAULT_DESCRIPTION },
    ])
  })

  it('cuts a long text to what the verifikat line keeps', () => {
    const [line] = payoutFeeLines([{ account: '6570', amount: 1, description: 'x'.repeat(250) }])
    expect(line.description).toHaveLength(PAYOUT_FEE_DESCRIPTION_MAX)
  })

  it('answers no rows for no fees', () => {
    expect(payoutFeeLines(undefined)).toEqual([])
    expect(payoutFeeLines(null)).toEqual([])
    expect(payoutFeeLines([])).toEqual([])
  })

  it('caps the rows at five, as the schema and the RPC do', () => {
    expect(MAX_PAYOUT_FEES).toBe(5)
  })
})

describe('payoutFeeTotal and payoutBankAmount', () => {
  it('sums the rounded rows once', () => {
    expect(payoutFeeTotal([{ account: '6570', amount: 0.1 }, { account: '6570', amount: 0.2 }])).toBe(0.3)
    expect(payoutFeeTotal(undefined)).toBe(0)
  })

  it("the issue's example: invoices of 6 000 + 4 000 less a 1 500 fee are a payout of 8 500", () => {
    expect(payoutBankAmount('customer_invoice', 10000, 1500)).toBe(8500)
  })

  it('a supplier payment is the invoices plus the bank fee', () => {
    expect(payoutBankAmount('supplier_invoice', 10000, 50)).toBe(10050)
  })
})

describe('payoutFeesWithinInvoices', () => {
  it('takes an OTA commission of 18 %, past the single-invoice 10 % cap', () => {
    expect(payoutFeesWithinInvoices(10000, 1800)).toBe(true)
  })

  it('refuses fees as large as the invoices or larger', () => {
    expect(payoutFeesWithinInvoices(1000, 1000)).toBe(false)
    expect(payoutFeesWithinInvoices(1000, 1000.004)).toBe(false)
    expect(payoutFeesWithinInvoices(1000, 999.99)).toBe(true)
  })
})
