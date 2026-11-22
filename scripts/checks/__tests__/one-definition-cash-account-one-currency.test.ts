/**
 * The cash-account-one-currency guard catches the refusal built by hand, and
 * leaves the callers that read it off the definition.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/cash-account-one-currency.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('cash-account-one-currency', () => {
  it.each([
    'throw new Error(`Cash account ${ledgerAccount} is denominated in ${row.currency}, not ${currency.toUpperCase()}`)',
    "throw Object.assign(new Error('mismatch'), { code: 'CASH_ACCOUNT_CURRENCY_MISMATCH' })",
    "return { error: message, errorCode: 'CASH_ACCOUNT_CURRENCY_MISMATCH', status: 409 }",
  ])('catches %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    'if (isCashAccountCurrencyMismatch(err)) return cashAccountCurrencyRefusal(err)',
    'throw codedRefusal(mismatch.code, message)',
    '`Invoice is denominated in ${invoiceCurrency} but carries no usable booking exchange rate `',
  ])('leaves %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
