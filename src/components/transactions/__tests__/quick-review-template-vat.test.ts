import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The Bokför review's warning when a template books another moms rate than
 * the underlag states (PostHog PH 118: a massage invoice at 25 % booked
 * through Friskvård's 6 %). The decision is templateVatMismatch
 * (lib/transactions/underlag-read.ts, tested there); Vitest runs in `node`
 * and never renders components, so like the sibling dialog tests these are
 * file-level assertions: the dialog must route through the helper with the
 * catalog template and the currency-checked underlag rate, and the sentence
 * it renders must exist in both locales with the placeholders it passes.
 */

const DIALOG_SRC = fs.readFileSync(path.resolve(__dirname, '../QuickReviewDialog.tsx'), 'utf8')
const readMessages = (locale: 'sv' | 'en') =>
  (
    JSON.parse(
      fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8'),
    ) as Record<string, Record<string, string>>
  ).tx_quick_review

describe('QuickReviewDialog template moms warning', () => {
  it('decides through templateVatMismatch with the catalog template and the underlag rate', () => {
    expect(DIALOG_SRC).toMatch(
      /templateVatMismatch\(\{\s*template:\s*catalogTemplate,\s*underlagRate:\s*underlagVatRate,\s*vatRegistered\s*\}\)/,
    )
    expect(DIALOG_SRC).toContain("t('vat_template_rate_differs'")
  })

  it('ships the sentence in both locales with the rates it is given', () => {
    for (const locale of ['sv', 'en'] as const) {
      const copy = readMessages(locale).vat_template_rate_differs
      expect(copy, locale).toBeTruthy()
      // next-intl throws on an unsupplied placeholder.
      expect(copy).toContain('{doc}')
      expect(copy).toContain('{template}')
    }
  })
})
