import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { PERMANENT_SIGNING_FAILURES } from '../payment-order-status'
import { providerCodeText } from '../payments-client'

/**
 * The bank's refusal codes as sentences: every code the signing screen may
 * show for good (PERMANENT_SIGNING_FAILURES) and every documented payment
 * refusal has a text under bank_payments.provider_<code> in both locales, the
 * Swedish one from the provider's own table. A code without a text falls back
 * to the generic sentence, so a missing key is silent in the UI; this is where
 * it is loud.
 */

const ROOT = path.resolve(__dirname, '../../..')
const messages = (locale: 'sv' | 'en') =>
  (JSON.parse(fs.readFileSync(path.join(ROOT, 'messages', `${locale}.json`), 'utf8')) as { bank_payments: Record<string, string> }).bank_payments

/** Payment refusals from the provider's error table. */
const DOCUMENTED_REFUSALS = [
  'FUNDS_NOT_AVAILABLE',
  'CREDITOR_ACCOUNT_INVALID',
  'DEBTOR_ACCOUNT_INVALID',
  'DAILY_PAYMENT_LIMIT_EXCEEDED',
  'PSU_ACCOUNT_LIMIT_EXCEEDED',
  'OCR_REF_REQUIRED',
  'PAYMENT_DUPLICATES_EXISTS',
  'PAYMENT_PRODUCT_AGREEMENT_MISSING',
  'PAYMENT_PSU_CANCELLED',
  'PAYMENT_EXECUTION_ERROR',
  'TPP_KYC_INVALID',
  'SIGNING_SESSION_EXPIRED',
  'SIGNING_SESSION_ONGOING',
  'SIGNING_SESSION_PSU_CANCELLED',
  'BASKET_PAYMENT_PRODUCT_NOT_SUPPORTED',
  'BASKET_PAYMENTS_PARTIALLY_REJECTED',
  'EXECUTION_DATE_INVALID',
  'EXECUTION_DATE_INVALID_PAST',
  'CONNECTOR_BANK_THROTTLED',
]

function tFor(locale: 'sv' | 'en') {
  const bank = messages(locale)
  const t = ((key: string) => bank[key] ?? `bank_payments.${key}`) as { (key: string): string; has: (key: string) => boolean }
  t.has = (key: string) => key in bank
  return t
}

describe('providerCodeText', () => {
  it.each(['sv', 'en'] as const)('has a sentence for every permanent failure and documented refusal (%s)', (locale) => {
    const t = tFor(locale)
    const missing = [...PERMANENT_SIGNING_FAILURES, ...DOCUMENTED_REFUSALS].filter((code) => providerCodeText(t, code) === null)
    expect(missing).toEqual([])
  })

  it.each(['sv', 'en'] as const)('asks for the Nordea Corporate Netbank logon id when the bank refused a signing for it (%s)', (locale) => {
    const text = providerCodeText(tFor(locale), 'PSU_AUTHORISER_ID_MISSING')
    expect(text).toContain('Nordea Corporate Netbank')
    expect(PERMANENT_SIGNING_FAILURES.has('PSU_AUTHORISER_ID_MISSING')).toBe(false)
  })

  it('answers null for an unknown or missing code, so the caller falls back to its generic sentence', () => {
    const t = tFor('sv')
    expect(providerCodeText(t, 'SOMETHING_NEW')).toBeNull()
    expect(providerCodeText(t, null)).toBeNull()
    expect(providerCodeText(t, undefined)).toBeNull()
  })

  it("names insufficient funds by the provider's code, not a code of our own", () => {
    for (const locale of ['sv', 'en'] as const) {
      const bank = messages(locale)
      expect(bank.provider_FUNDS_NOT_AVAILABLE).toBeTruthy()
      expect(bank).not.toHaveProperty('provider_INSUFFICIENT_FUNDS')
    }
  })

  it('keeps the Swedish and English provider texts in step', () => {
    const sv = Object.keys(messages('sv')).filter((k) => k.startsWith('provider_')).sort()
    const en = Object.keys(messages('en')).filter((k) => k.startsWith('provider_')).sort()
    expect(sv).toEqual(en)
  })
})
