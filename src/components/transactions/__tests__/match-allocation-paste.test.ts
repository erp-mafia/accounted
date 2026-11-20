import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The paste box of the batch allocation dialog (#75, the crm#1297
 * follow-up): one bank row matched against hundreds of invoices by pasting
 * their numbers. The parse, the resolution and the loader are unit tested in
 * lib/invoices (invoice-number-paste, open-invoice-search); this repo runs
 * Vitest in `node` and never renders components, so like the sibling dialog
 * tests these are file-level assertions on the wiring and the strings.
 */

const DIALOG_SRC = fs.readFileSync(path.resolve(__dirname, '../MatchAllocationDialog.tsx'), 'utf8')
const readMessages = (locale: 'sv' | 'en') =>
  (
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../../messages/${locale}.json`), 'utf8')) as Record<
      string,
      Record<string, string>
    >
  ).tx_match_allocation

describe('MatchAllocationDialog paste wiring', () => {
  it('resolves the paste with the tested loader and planner, never by hand', () => {
    expect(DIALOG_SRC).toContain('parseInvoicePaste(pasteText)')
    expect(DIALOG_SRC).toContain('loadInvoicesForPaste(')
    expect(DIALOG_SRC).toContain('planInvoicePaste(parsed, invoices')
  })

  it('holds the confirm past MAX_BANK_ROW_SPLIT instead of letting the route answer 400', () => {
    expect(DIALOG_SRC).toMatch(/const overLimit = pickedCount > MAX_BANK_ROW_SPLIT/)
    expect(DIALOG_SRC).toMatch(/disabled=\{[^}]*overLimit[^}]*\}/)
    expect(DIALOG_SRC).toMatch(/if \(!balanced \|\| overshoot \|\| overLimit\) return/)
  })

  it('reads a prefill of hundreds by id in slices, never in one query string', () => {
    expect(DIALOG_SRC).toContain('chunk(missingIds, ID_READ_CHUNK)')
    expect(DIALOG_SRC).not.toContain(".in('id', missingIds)")
  })
})

describe('MatchAllocationDialog strings', () => {
  const usedKeys = [
    ...new Set([
      ...[...DIALOG_SRC.matchAll(/\bt\('([a-z_]+)'/g)].map((m) => m[1]),
      ...[...DIALOG_SRC.matchAll(/'(paste_reason_[a-z_]+)'/g)].map((m) => m[1]),
    ]),
  ]

  it('finds the paste keys it is meant to check', () => {
    expect(usedKeys).toEqual(expect.arrayContaining(['paste_toggle', 'paste_reason_not_found', 'over_limit_warning']))
  })

  it('ships every key the dialog renders in both locales', () => {
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale)
      const missing = usedKeys.filter((key) => !messages[key])
      expect(missing, `${locale}.json tx_match_allocation`).toEqual([])
    }
  })

  it('names the placeholders the dialog passes', () => {
    // next-intl throws on an unsupplied placeholder, so the names must match.
    const expected: Record<string, string[]> = {
      paste_result_picked: ['{count', '{amount}'],
      paste_result_skipped: ['{count'],
      paste_reason_count: ['{reason}', '{count}'],
      paste_reason_ambiguous_row: ['{count}'],
      paste_reason_same_invoice_row: ['{earlier}'],
      paste_truncated: ['{max}'],
      paste_capped: ['{max}'],
      picked_summary: ['{count', '{amount}'],
      picked_count: ['{count}', '{max}'],
      over_limit_warning: ['{max}', '{excess}'],
    }
    for (const locale of ['sv', 'en'] as const) {
      const messages = readMessages(locale)
      for (const [key, placeholders] of Object.entries(expected)) {
        for (const placeholder of placeholders) expect(messages[key], `${locale} ${key}`).toContain(placeholder)
      }
    }
  })
})
