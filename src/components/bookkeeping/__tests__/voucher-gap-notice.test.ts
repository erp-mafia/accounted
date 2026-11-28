import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'

const NOTICE = fs.readFileSync(path.resolve(__dirname, '../VoucherGapNotice.tsx'), 'utf8')
const LIST = fs.readFileSync(path.resolve(__dirname, '../JournalEntryList.tsx'), 'utf8')

/**
 * Regression pins for the collapsed voucher-gap notice. The repo does not
 * render components in tests, so pin the source shape of the two properties
 * that carry compliance weight: explained gaps stay findable (BFNAR 2013:2
 * wants the documentation to exist and be reachable, not only stored), and
 * the unexplained line owns the page's single attn slot (convention 6).
 */
describe('VoucherGapNotice', () => {
  it('collapses unexplained gaps into one attn line with the Förklara action', () => {
    expect(NOTICE).toContain("t('gap_attn', { count: unexplained.length })")
    expect(NOTICE).toContain("label: t('gap_explain_action'), onClick: openDialog")
  })

  it('keeps explained gaps reachable behind the disclosure', () => {
    expect(NOTICE).toContain("t('gap_explained_toggle', { count: explained.length })")
    expect(NOTICE).toMatch(/showExplained && explained\.length > 0 &&/)
    expect(NOTICE).toContain('gap.explanation.created_at')
  })

  it('lets the dialog pick between several unexplained gaps', () => {
    expect(NOTICE).toMatch(/unexplained\.length > 1 &&/)
    expect(NOTICE).toContain("t('gap_dialog_pick_label')")
  })
})

describe('JournalEntryList attn slot', () => {
  it('gives the slot to unexplained gaps first, then imported missing underlag, then the import pointer', () => {
    expect(LIST).toContain('onUnexplainedCountChange={setUnexplainedGapCount}')
    expect(LIST).toContain('unexplainedGapCount === 0 && importedMissingCount > 0 ?')
    expect(LIST).toMatch(/unexplainedGapCount === 0 &&\s+entries\.some\(\(e\) => e\.source_type === 'import'\)/)
  })

  it('counts imported rows without underlag here with the same predicate the row mark uses', () => {
    expect(LIST).toContain(
      "entries.filter((e) => underlagInEarlierSystem(e.source_type) && isEligibleForExempt(e)).length",
    )
    expect(LIST).toContain("t('import_missing_attn_page', { count: importedMissingCount })")
  })

  it('gives an imported row its own quiet status and every other needs-doc row the chip', () => {
    // The fragment holds the chip and its phone-width glyph (phone-width-lists.test.ts).
    expect(LIST).toMatch(/underlagInEarlierSystem\(entry\.source_type\) \? \(/)
    expect(LIST).toContain("t('imported_underlag_indicator_tooltip')")
    expect(LIST).toMatch(/\) : \(\s+<>\s+<Badge variant="warning"/)
  })
})
