/**
 * Regler (/rules): the rules and Spärrar tables bleed their scroll container
 * to the panel edges with a negative margin equal to the page padding
 * (MainContainer: px-4, md:px-6). They used -mx-5, which overshot a phone's
 * 16px gutter by 4px per side and scrolled the whole page sideways on a 375px
 * screen. Stil v3: the tables sit in the list bleed (LIST_BLEED_CLASS, 8px),
 * well inside the gutter.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (p: string) => readFileSync(join(root, p), 'utf8')
const container = read('src/components/dashboard/MainContainer.tsx')

describe('Regler table scrollers', () => {
  it('the page container pads px-4 and md:px-6', () => {
    expect(container).toContain('px-4 pb-8 pt-4 md:px-6')
  })

  it.each(['src/components/rules/RulesList.tsx', 'src/components/rules/BookingBlocks.tsx'])('%s bleeds no further than the page padding', (file) => {
    const src = read(file)
    expect(src).toContain("className={cn(LIST_BLEED_CLASS, 'overflow-x-auto')}")
    expect(src).not.toMatch(/className="[^"]*-mx-5/)
  })
})
