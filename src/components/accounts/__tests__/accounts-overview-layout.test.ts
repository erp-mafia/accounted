/**
 * Konton (/accounts): the account table bleeds its scroll container to the
 * panel edges with a negative margin equal to the page padding (MainContainer:
 * px-4, md:px-6). It used -mx-5, which overshot a phone's 16px gutter by 4px
 * per side and scrolled the whole page sideways on a 375px screen. Stil v3:
 * the inner padding is 8px less than the page padding (the 8px list bleed).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const overview = readFileSync(join(root, 'src/components/accounts/AccountsOverview.tsx'), 'utf8')
const container = readFileSync(join(root, 'src/components/dashboard/MainContainer.tsx'), 'utf8')

describe('Konton table scroller', () => {
  it('the page container pads px-4 and md:px-6', () => {
    expect(container).toContain('px-4 pb-8 pt-4 md:px-6')
  })

  it('bleeds exactly the page padding', () => {
    expect(overview).toContain('className="-mx-4 overflow-x-auto px-2 md:-mx-6 md:px-4"')
    expect(overview).not.toMatch(/className="[^"]*-mx-5/)
  })
})

// Session replays showed Saldo cut off at a phone's right edge. Below sm the
// row is the account and its balance; the account's reconciliation, which
// the row opens, has the rest.
describe('Konton on a phone', () => {
  it('hides Senast läst, Avstämt t.o.m., Att granska and Oförklarat below sm', () => {
    const head = overview.slice(overview.indexOf('<thead>'), overview.indexOf('</thead>'))
    for (const key of ["t('th_synced')", "t('th_signed_off')", "t('th_review')", "tRec('v2_th_unexplained')"]) {
      const th = head.slice(head.lastIndexOf('<th', head.indexOf(key)), head.indexOf(key))
      expect(th).toContain('hidden')
      expect(th).toContain('sm:table-cell')
    }
    const balance = head.slice(head.lastIndexOf('<th', head.indexOf("t('th_balance')")), head.indexOf("t('th_balance')"))
    expect(balance).not.toContain('hidden')
  })

  it('lets the account name truncate instead of widening the table', () => {
    expect(overview).toContain("<td className={cn(TD_CLASS, 'max-w-0 !pl-0')}>")
  })
})

// The account's reconciliation: a seven-figure balance at 20px is wider than
// half a phone and cannot wrap, so the strip's right column ran off the screen.
describe('reconciliation figures on a phone', () => {
  const account = readFileSync(join(root, 'src/components/reconciliation/AccountOverview.tsx'), 'utf8')

  it('sets the tile values at 15px below sm and 20px from sm', () => {
    expect(account).toContain("'mt-1 text-base font-semibold leading-tight tabular-nums sm:text-xl'")
  })
})
