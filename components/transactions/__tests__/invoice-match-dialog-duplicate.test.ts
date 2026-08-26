import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The duplicate-payment warning panel of the invoice-match dialog.
 *
 * Two bugs pinned here:
 *
 * 1. `candidate.amount` is the voucher leg's SEK debit
 *    (lib/invoices/duplicate-payment-detection.ts), but the dialog formatted
 *    it in the TRANSACTION's currency: an 11 500 kr leg on a EUR bank line
 *    printed as "11 500,00 EUR".
 * 2. When the bank line had no stored SEK value the detector's amount test
 *    never ran, yet the candidate came back labelled 'exact_amount_*' and the
 *    dialog claimed "på samma belopp" for amounts that were never compared.
 *    The detector now returns reason 'date_window_only' + amount_verified:
 *    false for that shape, and the dialog renders copy that does not claim an
 *    amount match.
 *
 * This repo runs Vitest in the `node` environment and never renders
 * components, so like the sibling invoice-match-dialog-fx test these are
 * file-level assertions: the source must not carry the buggy expression, and
 * the strings it renders must exist in both locales.
 */

const DIALOG_SRC = fs.readFileSync(path.resolve(__dirname, '../InvoiceMatchDialog.tsx'), 'utf8')
const BOOKING_DIALOG_SRC = fs.readFileSync(
  path.resolve(__dirname, '../DuplicateBookingDialog.tsx'),
  'utf8',
)
const readMessages = (locale: 'sv' | 'en', namespace: string) =>
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, Record<string, string>>
  )[namespace]

describe('InvoiceMatchDialog duplicate-candidate rendering', () => {
  it('formats the voucher leg amount as SEK, never in the transaction currency', () => {
    expect(DIALOG_SRC).not.toMatch(/formatCurrency\(candidate\.amount,\s*transaction\.currency\)/)
    expect(DIALOG_SRC).toMatch(/formatCurrency\(candidate\.amount,\s*'SEK'\)/)
  })

  it('branches to unverified copy on date_window_only / amount_verified false', () => {
    expect(DIALOG_SRC).toContain("'date_window_only'")
    expect(DIALOG_SRC).toContain('amount_verified')
    expect(DIALOG_SRC).toContain("t('duplicate_body_unverified'")
  })

  it('ships the unverified copy in both locales without claiming an amount match', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale, 'tx_invoice_match')
      const copy = messages.duplicate_body_unverified
      expect(copy).toBeTruthy()
      // next-intl throws on an unsupplied placeholder, so the parameter names
      // must match what the dialog passes.
      expect(copy).toContain('{label}')
      expect(copy).toContain('{amount}')
      expect(copy).toContain('{date}')
      // The whole point of the branch: no "same amount" claim.
      expect(copy).not.toMatch(/samma belopp|same amount/i)
    }
  })
})

describe('DuplicateBookingDialog rateless-sibling warning', () => {
  it('gates the currency-naming warning on candidate.currency being present', () => {
    // t('dialog_duplicate_sek_unavailable', { currency }) interpolates the
    // currency into the sentence; an empty string renders broken Swedish, so
    // the branch must not fire for a null-currency candidate.
    expect(BOOKING_DIALOG_SRC).toMatch(
      /candidate\.amount == null && candidate\.currency &&/,
    )
    expect(BOOKING_DIALOG_SRC).not.toMatch(/candidate\.currency \?\? ''/)
  })

  it('keeps the warning strings in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale, 'transactions')
      expect(messages.dialog_duplicate_sek_unavailable).toContain('{currency}')
      expect(messages.dialog_duplicate_amount_unknown).toBeTruthy()
    }
  })
})

describe('DuplicateBookingDialog sibling candidates', () => {
  it('no longer gates the match action on transaction_id being null', () => {
    // manualLink explicitly allows N:1 (a second bank line on one voucher), so
    // sibling-transaction candidates must get "Matcha mot verifikatet" too:
    // hiding it dead-ended the user in "Bokför ändå".
    expect(BOOKING_DIALOG_SRC).toMatch(
      /const canMatch = candidate !== null && !!matchTransaction && !!onMatched/,
    )
    expect(BOOKING_DIALOG_SRC).not.toMatch(/canMatch =[\s\S]{0,120}transaction_id === null/)
  })

  it('offers Ignorera for sibling candidates via the existing ignore endpoint', () => {
    // The sibling shape is very often a duplicate IMPORT of one real movement;
    // ignoring the row is then the correct resolution (matching would
    // double-count the bank side, booking would double-count the ledger side).
    expect(BOOKING_DIALOG_SRC).toMatch(/\/api\/transactions\/\$\{matchTransaction\.id\}\/ignore/)
    expect(BOOKING_DIALOG_SRC).toContain("t('dialog_duplicate_ignore')")
    // Gated on a sibling candidate: never shown for ledger-only vouchers.
    expect(BOOKING_DIALOG_SRC).toMatch(
      /canIgnore = isSiblingCandidate && !!matchTransaction && !!onIgnored/,
    )
  })

  it('switches the body copy to the "matcha i stället" question for sibling candidates', () => {
    expect(BOOKING_DIALOG_SRC).toContain("t('dialog_duplicate_body_sibling')")
    expect(BOOKING_DIALOG_SRC).toMatch(
      /isSiblingCandidate \? t\('dialog_duplicate_body_sibling'\) : t\('dialog_duplicate_body'\)/,
    )
  })

  it('ships the sibling strings in both locales, without dashes', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale, 'transactions')
      for (const key of [
        'dialog_duplicate_body_sibling',
        'dialog_duplicate_ignore',
        'dialog_duplicate_ignore_hint',
        'dialog_duplicate_ignore_failed',
      ]) {
        expect(messages[key], `${locale}.transactions.${key}`).toBeTruthy()
        expect(messages[key]).not.toMatch(/–|—/)
      }
      // The ignore guidance lives in the gated hint, never in the body: two
      // render sites (manual booking form, bulk dialog) show sibling
      // candidates without the ignore action, and body copy must not point at
      // a button that is not there.
      expect(messages.dialog_duplicate_body_sibling).not.toMatch(/ignorera|ignore it/i)
    }
    // The requested copy pattern: an offer to match instead, in question form.
    expect(readMessages('sv', 'transactions').dialog_duplicate_body_sibling).toMatch(
      /matcha[\s\S]*i stället/i,
    )
  })

  it('renders the ignore hint only when the ignore action is offered', () => {
    expect(BOOKING_DIALOG_SRC).toMatch(/canIgnore && <> \{t\('dialog_duplicate_ignore_hint'\)\}<\/>/)
  })
})
