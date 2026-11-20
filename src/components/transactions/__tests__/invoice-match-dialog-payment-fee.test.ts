/**
 * The match dialog's half of a payment provider's fee (crm#1364). The preview
 * route reports a SEK payout short of the invoice by what could be the
 * provider's fee; the dialog asks whether it is, never assumes it, keeps
 * Confirm off until the preview shows the choice, and sends the fee it showed
 * so the route books that amount or refuses. No component test runner exists
 * in this repo, so the dialog source and the messages are read here, as
 * invoice-match-dialog-overpayment.test.ts does.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const SRC = fs.readFileSync(path.resolve(__dirname, '../InvoiceMatchDialog.tsx'), 'utf8')
const PAGE = fs.readFileSync(
  path.resolve(__dirname, '../../../app/(dashboard)/transactions/page.tsx'),
  'utf8',
)
const readMessages = (locale: 'sv' | 'en') =>
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, Record<string, string>>
  ).tx_invoice_match

describe('InvoiceMatchDialog: a payment provider fee', () => {
  it('starts with no fee named and forgets it for another transaction or invoice', () => {
    expect(SRC).toContain('const [feeAccount, setFeeAccount] = useState<string | null>(null)')
    expect(SRC).toMatch(/setOverpaymentAccount\(null\)\n\s+setFeeAccount\(null\)\n\s+stopEditing\(\)\n\s+\}, \[transactionId, invoiceId, stopEditing\]\)/)
  })

  it('asks the preview for the named fee account', () => {
    expect(SRC).toContain('(feeAccount ? `&fee_account=${feeAccount}` : \'\')')
  })

  it('keeps Confirm disabled while a required fee is unnamed or the preview lags the choice', () => {
    expect(SRC).toContain("(!!customerFee && (feeUnplaced || (customerFee.account ?? null) !== feeAccount))")
  })

  it('sends the fee the preview showed, and the page forwards it', () => {
    expect(SRC).toContain('fee_account: fee.account, fee_amount: fee.fee')
    expect(PAGE).toContain('body.fee_account = opts.fee_account')
    expect(PAGE).toContain('body.fee_amount = opts.fee_amount')
  })

  it('ships the strings in both locales, with the amount placeholder', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale)
      for (const key of [
        'payment_fee_title',
        'payment_fee_description',
        'payment_fee_required_note',
        'payment_fee_choose',
        'payment_fee_option_partial',
        'payment_fee_hint_partial',
        'payment_fee_option_fee',
        'payment_fee_hint_fee',
        'payment_fee_choose_first',
      ]) {
        expect(messages[key], `${locale}.${key}`).toBeTruthy()
      }
      expect(messages.payment_fee_title).toContain('{amount}')
    }
  })
})
