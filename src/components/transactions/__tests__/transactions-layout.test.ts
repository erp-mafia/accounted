/**
 * Transaktioner layout rules that a render test would not catch cheaply.
 *
 * The column chooser changes the optional columns of the Att bokföra table
 * only (Alla and Granska förslag have none), and 2 of 945 page users touched
 * it in 14 days (PostHog, 2026-10-28). It lives in that table's head, not in
 * the page toolbar every mode shares.
 *
 * Both lists bleed their scroll container to the panel edges with a negative
 * margin equal to the page padding (MainContainer: px-4, md:px-6). The Alla
 * list used -mx-5 / md:-mx-8, wider than the padding, so its scroller ran
 * past the panel's content box.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const page = readFileSync(join(root, 'src/app/(dashboard)/transactions/page.tsx'), 'utf8')
const history = readFileSync(join(root, 'src/components/transactions/TransactionHistoryList.tsx'), 'utf8')
const container = readFileSync(join(root, 'src/components/dashboard/MainContainer.tsx'), 'utf8')

describe('Transaktioner column chooser', () => {
  it('is not in the page toolbar', () => {
    const toolbarStart = page.indexOf('<SegmentedControl')
    const toolbarEnd = page.indexOf('{/* Content based on mode */}')
    expect(toolbarStart).toBeGreaterThan(-1)
    expect(toolbarEnd).toBeGreaterThan(toolbarStart)
    expect(page.slice(toolbarStart, toolbarEnd)).not.toContain("t('columns_button')")
  })

  it('sits in the head of the Att bokföra table, which is the table it changes', () => {
    const chooser = page.indexOf("aria-label={t('columns_button')}")
    const head = page.lastIndexOf('<thead>', chooser)
    const headEnd = page.indexOf('</thead>', head)
    expect(chooser).toBeGreaterThan(-1)
    expect(head).toBeGreaterThan(-1)
    expect(chooser).toBeLessThan(headEnd)
    // The same table renders the rows that read txColumns.
    const bodyEnd = page.indexOf('</tbody>', headEnd)
    expect(page.slice(headEnd, bodyEnd)).toContain('columns={txColumns}')
  })
})

describe('list scrollers bleed exactly the page padding', () => {
  it('the page container pads px-4 and md:px-6', () => {
    expect(container).toContain('px-4 pb-8 pt-4 md:px-6')
  })

  it('the Att bokföra table and the Alla list use the same negative margin', () => {
    expect(page).toContain('-mx-4 px-4 md:-mx-6 md:px-6')
    expect(history).toContain('-mx-4 overflow-x-auto px-4 md:-mx-6 md:px-6')
    expect(history).not.toMatch(/-mx-5|md:-mx-8/)
  })
})
