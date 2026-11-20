import { describe, it, expect } from 'vitest'
import {
  INVOICE_POSTING_ACCOUNT_REGEX,
  isInvoiceLinePostingAccount,
  isZeroVatOnlyPostingAccount,
} from '@/lib/invoices/posting-account'
import { CreateInvoiceItemSchema } from '@/lib/api/schemas'

describe('invoice line posting accounts (PH 246)', () => {
  it('takes class 1-3 and the interest-income groups 825x, 826x, 831x and 836x', () => {
    for (const account of ['1385', '1510', '2420', '3001', '3041', '8251', '8262', '8313', '8361']) {
      expect(isInvoiceLinePostingAccount(account)).toBe(true)
    }
  })

  it('keeps costs, payroll and the rest of class 8 out', () => {
    for (const account of ['4010', '5010', '6570', '7010', '8010', '8210', '8220', '8336', '8410', '8811', '8910', '825', '82510']) {
      expect(isInvoiceLinePostingAccount(account)).toBe(false)
    }
  })

  it('leaves the article account rule at class 1-3', () => {
    expect(INVOICE_POSTING_ACCOUNT_REGEX.test('8251')).toBe(false)
    expect(INVOICE_POSTING_ACCOUNT_REGEX.test('3041')).toBe(true)
  })

  it('requires 0 % VAT on balance-sheet and interest lines only', () => {
    expect(isZeroVatOnlyPostingAccount('1385')).toBe(true)
    expect(isZeroVatOnlyPostingAccount('8251')).toBe(true)
    expect(isZeroVatOnlyPostingAccount('3001')).toBe(false)
  })

  it('the invoice item schema accepts an interest row and refuses a cost account', () => {
    const base = { description: 'Ränta oktober', quantity: 1, unit: 'st', unit_price: 500, vat_rate: 0 }
    expect(CreateInvoiceItemSchema.safeParse({ ...base, revenue_account: '8251' }).success).toBe(true)
    expect(CreateInvoiceItemSchema.safeParse({ ...base, revenue_account: '8410' }).success).toBe(false)
  })
})
