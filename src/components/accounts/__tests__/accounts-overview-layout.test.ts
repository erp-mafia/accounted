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
