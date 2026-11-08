/**
 * A truncating label in a flex row needs min-w-0: a flex item never shrinks
 * below its min-content width, and a nowrap label's min-content is the whole
 * text, so a long company name, category or command label pushed its
 * neighbours (chevron, level, amount) out of the row instead of truncating.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('truncating labels in flex rows', () => {
  it.each([
    ['src/components/dashboard/UserMenu.tsx', '<span className="min-w-0 flex-1 truncate">\n                  {cockpitMode'],
    ['src/components/dashboard/SidebarV2.tsx', '<span className="min-w-0 flex-1 truncate">{label(item.labelKey)}</span>'],
    ['src/components/common/CommandPalette.tsx', '<span className="min-w-0 flex-1 truncate">{entry.label}</span>'],
    ['src/components/inbox/PurchaseCategoryChip.tsx', '<span className="min-w-0 truncate">{isPurchaseCategoryCode(current.code)'],
    ['src/components/pending-operations/OperationPreview.tsx', '<span className="min-w-0 truncate mr-4">'],
  ])('%s', (file, snippet) => {
    expect(read(file)).toContain(snippet)
  })

  it('the Inkorg proposal table truncates its description inside the cell', () => {
    expect(read('src/components/inkorg/FocusStage.tsx')).toContain('className="max-w-0 truncate py-1 pr-2"')
  })
})

describe('rows and footers that wrap instead of overflowing', () => {
  it('a Hem grant posting wraps its badges and buttons', () => {
    expect(read('src/components/dashboard/GrantPostings.tsx')).toContain('className="flex flex-wrap items-center gap-3 border-b border-border px-1 py-3 text-[13px]"')
  })

  it('the Kvittojakten prerequisites footer wraps a long client name', () => {
    expect(read('src/components/dashboard/KvittojaktenButton.tsx')).toContain('<DialogFooter className="sm:flex-wrap sm:gap-2 sm:space-x-0">')
  })
})
