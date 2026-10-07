/**
 * The match dialog's half of a customer overpayment (crm#1045). The preview
 * route reports a SEK excess of a krona or more with the accounts that may
 * take it; the dialog must ask for one, never pick it, and send the excess it
 * showed so the route books that amount or refuses. No component test runner
 * exists in this repo, so the dialog source and the messages are read here,
 * as invoice-match-dialog-fx.test.ts does.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = fs.readFileSync(path.resolve(__dirname, '../InvoiceMatchDialog.tsx'), 'utf8')
const readMessages = (locale: 'sv' | 'en') =>
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, Record<string, string>>
  ).tx_invoice_match

describe('InvoiceMatchDialog: a customer overpayment', () => {
  it('starts with no account picked', () => {
    expect(SRC).toMatch(/useState<string \| null>\(null\)/)
    expect(SRC).not.toMatch(/setOverpaymentAccount\((['"])\d{4}\1\)/)
  })

  it('keeps Confirm disabled until the preview shows the picked account', () => {
    expect(SRC).toContain(
      '(!customerOverpayment.account || customerOverpayment.account !== overpaymentAccount)',
    )
  })

  it('sends the account with the excess the preview showed', () => {
    expect(SRC).toContain('overpayment_account: placed.account, overpayment_amount: placed.excess')
  })

  it('ships the strings in both locales, with the amount placeholder', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale)
      for (const key of [
        'customer_overpayment_title',
        'customer_overpayment_description',
        'customer_overpayment_choose',
        'customer_overpayment_account_3740',
        'customer_overpayment_hint_3740',
        'customer_overpayment_account_2420',
        'customer_overpayment_hint_2420',
        'customer_overpayment_choose_first',
      ]) {
        expect(messages[key], `${locale}.${key}`).toBeTruthy()
      }
      expect(messages.customer_overpayment_title).toContain('{amount}')
    }
  })
})
