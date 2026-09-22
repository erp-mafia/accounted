import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const SRC = fs.readFileSync(
  path.resolve(__dirname, '../JournalEntryList.tsx'),
  'utf8',
)

/**
 * Regression pin for the per-row copy affordance (#1266).
 *
 * The icon was removed as collateral of the row-language rewrite in #1123: its
 * slot was reused for the expand toggle, and the only trace left was an
 * orphaned `copy_voucher_tooltip` key in both message files. The repo does not
 * render components in tests, so nothing observed the loss; pin the source
 * shape instead, the same way NewInvoiceDialog's copy query is pinned.
 */
describe('JournalEntryList row copy affordance', () => {
  it('keeps the Copy icon imported from lucide', () => {
    const importLine = SRC.split('\n').find(
      (l) => l.includes("from 'lucide-react'") && l.startsWith('import'),
    )
    expect(importLine).toBeDefined()
    expect(importLine).toContain('Copy')
  })

  it('references copy_voucher_tooltip, so the i18n key is not orphaned', () => {
    expect(SRC).toContain("t('copy_voucher_tooltip')")
  })

  it('labels the row icon for screen readers', () => {
    expect(SRC).toContain("aria-label={t('copy_voucher_tooltip')}")
  })

  it('stops propagation before navigating, so copying never toggles the foldout', () => {
    // The whole <tr> is the expand toggle, so a copy click that bubbles would
    // open the row instead of (or as well as) starting the copy.
    const start = SRC.indexOf("aria-label={t('copy_voucher_tooltip')}")
    expect(start).toBeGreaterThan(-1)
    const push = SRC.indexOf('/bookkeeping?copy_from=${entry.id}', start)
    expect(push).toBeGreaterThan(-1)

    const handler = SRC.slice(start, push)
    expect(handler).toContain('e.stopPropagation()')
  })
})
