/**
 * Arkiv on a phone: the agreements table scrolls in place instead of the page,
 * the folder tree keeps its title column (its fixed columns take 590px, which
 * left the auto title column at zero on a phone and narrow with the assistant
 * docked), and a field value without spaces (an e-mail, a URL) wraps.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('Arkiv layout at narrow widths', () => {
  it('the agreements table has its own horizontal scroller', () => {
    expect(read('src/components/arkiv/ArkivAgreements.tsx')).toMatch(/<div className="overflow-x-auto">\s*<table className="w-full border-collapse text-\[13px\]">/)
  })

  it('the folder tree table has a minimum width that leaves room for the title', () => {
    expect(read('src/components/arkiv/ArkivTree.tsx')).toContain('<table className="w-full min-w-[46rem] table-fixed border-collapse text-[13px]">')
  })

  it('a field value breaks long words', () => {
    expect(read('src/components/arkiv/DefList.tsx')).toContain("cn('min-w-0 break-words tabular-nums'")
  })
})
