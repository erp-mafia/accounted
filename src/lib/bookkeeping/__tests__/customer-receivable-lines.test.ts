import { describe, expect, it } from 'vitest'
import {
  CUSTOMER_RECEIVABLE_DEFAULT_ACCOUNT,
  CUSTOMER_RECEIVABLE_DEFAULT_DESCRIPTION,
  CUSTOMER_RECEIVABLE_DESCRIPTION_MAX,
  customerReceivableLines,
  customerReceivableTotal,
  isCustomerReceivableAccount,
} from '../customer-receivable-lines'
import { payoutBankAmount } from '../payout-fee-lines'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'

describe('isCustomerReceivableAccount', () => {
  it('starts on 1510 Kundfordringar', () => {
    expect(CUSTOMER_RECEIVABLE_DEFAULT_ACCOUNT).toBe('1510')
  })

  it('takes the 151x customer receivable accounts', () => {
    for (const account of ['1510', '1511', '1512', '1513', '1518', '1519']) {
      expect(isCustomerReceivableAccount(account)).toBe(true)
    }
  })

  it('refuses every other account, a short or long number and a number given as a number', () => {
    for (const account of ['1930', '1520', '1500', '2440', '2420', '3740', '151', '15100', '']) {
      expect(isCustomerReceivableAccount(account)).toBe(false)
    }
    expect(isCustomerReceivableAccount(1510 as unknown as string)).toBe(false)
  })

  it('no account a momsdeklaration ruta reads can take a receivable row: the row carries no VAT', () => {
    expect(Object.keys(VAT_ACCOUNT_TABLE).filter(isCustomerReceivableAccount)).toEqual([])
  })
})

describe('customerReceivableLines', () => {
  it('rounds to the öre, trims the text and falls back to the default text', () => {
    expect(
      customerReceivableLines([
        { account: '1510', amount: 1250.004, description: '  Faktura 9001  ' },
        { account: '1510', amount: 99.995 },
        { account: '1510', amount: 10, description: '   ' },
      ]),
    ).toEqual([
      { account: '1510', amount: 1250, description: 'Faktura 9001' },
      { account: '1510', amount: 100, description: CUSTOMER_RECEIVABLE_DEFAULT_DESCRIPTION },
      { account: '1510', amount: 10, description: CUSTOMER_RECEIVABLE_DEFAULT_DESCRIPTION },
    ])
    expect(CUSTOMER_RECEIVABLE_DEFAULT_DESCRIPTION).toBe('Kundfordran från tidigare bokföring')
  })

  it('cuts a long text to the line length', () => {
    const [line] = customerReceivableLines([{ account: '1510', amount: 1, description: 'x'.repeat(250) }])
    expect(line!.description).toHaveLength(CUSTOMER_RECEIVABLE_DESCRIPTION_MAX)
  })

  it('no rows: none', () => {
    expect(customerReceivableLines(undefined)).toEqual([])
    expect(customerReceivableLines(null)).toEqual([])
    expect(customerReceivableLines([])).toEqual([])
  })
})

describe('customerReceivableTotal and the bank row', () => {
  it('sums the rounded rows once', () => {
    expect(customerReceivableTotal([{ account: '1510', amount: 0.1 }, { account: '1510', amount: 0.2 }])).toBe(0.3)
    expect(customerReceivableTotal(undefined)).toBe(0)
  })

  it('a deposit is the invoices less the fees plus the receivable from before', () => {
    expect(payoutBankAmount('customer_invoice', 3000, 0, 1250)).toBe(4250)
    expect(payoutBankAmount('customer_invoice', 3000, 25, 1250)).toBe(4225)
  })

  it('a receivable row may be larger than the invoices it is paid with', () => {
    expect(payoutBankAmount('customer_invoice', 100, 0, 9000)).toBe(9100)
  })
})
