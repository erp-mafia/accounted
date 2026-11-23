import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Inkommande's focus view opened from Att bokföra (a document row, with
 * `tillbaka`): its way back, Esc included, and the end of the queue lead
 * back to the list with its filter, and the list stays lit in the menu.
 * Opened any other way, nothing changes.
 */
const PAGE_SRC = fs.readFileSync(path.resolve(__dirname, '../InkorgPage.tsx'), 'utf8')

describe('Inkommande returns to Att bokföra', () => {
  it('reads the return address only through toBookReturnPath, and only with a document asked for', () => {
    expect(PAGE_SRC).toContain('wantedFocus.current ? toBookReturnPath(searchParams.get(TO_BOOK_RETURN_PARAM)) : null')
    expect(PAGE_SRC).toContain('useClaimNavRow(INKORG_HREF, returnTo ? TO_BOOK_PATH : null)')
  })

  it('goes back there from the focus view and when nothing is left to decide', () => {
    const back = PAGE_SRC.slice(PAGE_SRC.indexOf('const back = useCallback('), PAGE_SRC.indexOf('const chooseView = useCallback('))
    expect(back).toMatch(/if \(returnTo\) \{\s*router\.push\(returnTo\)\s*return\s*\}/)
    expect(PAGE_SRC).toMatch(/if \(next === null\) \{[^}]*if \(returnTo\) router\.push\(returnTo\)/)
  })

  it('names the way back after the list', () => {
    expect(PAGE_SRC).toContain("viewLabel={returnTo ? tToBook('title') : viewLabel}")
  })
})
