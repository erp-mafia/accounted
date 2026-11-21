import { describe, expect, it } from 'vitest'
import {
  SUPPLIER_DEBT_DEFAULT_ACCOUNT,
  SUPPLIER_DEBT_DEFAULT_DESCRIPTION,
  SUPPLIER_DEBT_DESCRIPTION_MAX,
  isSupplierDebtAccount,
  supplierDebtLines,
  supplierDebtTotal,
} from '../supplier-debt-lines'
import { payoutBankAmount } from '../payout-fee-lines'
import { VAT_ACCOUNT_TABLE } from '@/lib/vat/moms-box-mapping'

describe('isSupplierDebtAccount', () => {
  it('starts on 2440 Leverantörsskulder', () => {
    expect(SUPPLIER_DEBT_DEFAULT_ACCOUNT).toBe('2440')
  })

  it('takes the 244x supplier debt accounts', () => {
    for (const account of ['2440', '2441', '2445', '2448', '2449']) expect(isSupplierDebtAccount(account)).toBe(true)
  })

  it('refuses every other account, a short or long number and a number given as a number', () => {
    for (const account of ['1930', '2450', '2430', '2640', '6570', '244', '24400', '']) {
      expect(isSupplierDebtAccount(account)).toBe(false)
    }
    expect(isSupplierDebtAccount(2440 as unknown as string)).toBe(false)
  })

  it('no account a momsdeklaration ruta reads can take a debt row: the row carries no VAT', () => {
    expect(Object.keys(VAT_ACCOUNT_TABLE).filter(isSupplierDebtAccount)).toEqual([])
  })
})

describe('supplierDebtLines', () => {
  it('rounds to the öre, trims the text and falls back to the default text', () => {
    expect(
      supplierDebtLines([
        { account: '2440', amount: 12546.504, description: '  Faktura 4411 och 4412  ' },
        { account: '2448', amount: 99.995 },
        { account: '2440', amount: 10, description: '   ' },
        { account: '2440', amount: 1, description: null },
      ]),
    ).toEqual([
      { account: '2440', amount: 12546.5, description: 'Faktura 4411 och 4412' },
      { account: '2448', amount: 100, description: SUPPLIER_DEBT_DEFAULT_DESCRIPTION },
      { account: '2440', amount: 10, description: SUPPLIER_DEBT_DEFAULT_DESCRIPTION },
      { account: '2440', amount: 1, description: SUPPLIER_DEBT_DEFAULT_DESCRIPTION },
    ])
  })

  it('cuts a long text to what the verifikat line keeps', () => {
    const [line] = supplierDebtLines([{ account: '2440', amount: 1, description: 'x'.repeat(250) }])
    expect(line.description).toHaveLength(SUPPLIER_DEBT_DESCRIPTION_MAX)
  })

  it('answers no rows for no debts', () => {
    expect(supplierDebtLines(undefined)).toEqual([])
    expect(supplierDebtLines(null)).toEqual([])
    expect(supplierDebtLines([])).toEqual([])
  })
})

describe('supplierDebtTotal and the bank row', () => {
  it('sums the rounded rows once', () => {
    expect(supplierDebtTotal([{ account: '2440', amount: 0.1 }, { account: '2440', amount: 0.2 }])).toBe(0.3)
    expect(supplierDebtTotal(undefined)).toBe(0)
  })

  it('a supplier payment is the invoices plus the fees plus the debt from before', () => {
    expect(payoutBankAmount('supplier_invoice', 16000, 0, 12546.5)).toBe(28546.5)
    expect(payoutBankAmount('supplier_invoice', 16000, 25, 12546.5)).toBe(28571.5)
  })

  it('a debt row may be larger than the invoices it is paid with', () => {
    expect(payoutBankAmount('supplier_invoice', 1000, 0, 27546.5)).toBe(28546.5)
  })

  it('a customer payout never counts a debt', () => {
    expect(payoutBankAmount('customer_invoice', 10000, 1500, 500)).toBe(8500)
  })
})
