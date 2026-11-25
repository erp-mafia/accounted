import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

/**
 * The doors that offer a correction ask correctionPaths
 * (lib/core/bookkeeping/correction-paths.ts) which paths apply, and offer
 * only those: the verifikat page's Rätta menu and the verifikat list's row.
 * The repo does not render components in tests, so the wiring is pinned in
 * the source.
 */
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, rel), 'utf8')
const PAGE = read('../../../app/(dashboard)/bookkeeping/[id]/page.tsx')
const LIST = read('../JournalEntryList.tsx')
const PAIRS = read('../../reconciliation/ReconciliationPairs.tsx')

describe('the verifikat page Rätta menu', () => {
  it('asks correctionPaths with the chain and the period verdict', () => {
    expect(PAGE).toContain('correctionPaths({')
    expect(PAGE).toContain('stornoed: stornoedInLaterPeriod,')
  })

  it('renders each path only where it applies, with no state that disables a refused path instead', () => {
    for (const rendered of ["paths.inline.includes('strike_lines')", "paths.inline.includes('correct_metadata')", "paths.storno.includes('correct_lines')", "paths.storno.includes('correct_date')", "paths.storno.includes('reverse')"]) {
      expect(PAGE).toContain(rendered)
    }
    expect(PAGE).not.toContain('disabled={!canWrite || yearClosed}')
    expect(PAGE).not.toContain('correctLinesBlocked')
  })
})

describe('the verifikat list row', () => {
  it('waits for the period verdict of the open row and leads with the path that applies', () => {
    expect(LIST).toContain("canWrite && entry.status === 'posted' && expandedPeriod && (() => {")
    expect(LIST).toContain('const lead = leadingCorrectionPath(paths)')
    expect(LIST).toContain("lead === 'strike_lines'")
    expect(LIST).toContain("lead === 'correct_lines'")
    expect(LIST).toContain("paths.storno.includes('reverse')")
  })
})

describe("Avstämning's Bokför on a bank row", () => {
  it('opens the booking screen where it is switched on', () => {
    expect(PAIRS).toContain('bankRowBookHref(item.item_id, bookingScreen)')
    expect(PAIRS).not.toContain('`/transactions?highlight=${item.item_id}`')
  })
})
