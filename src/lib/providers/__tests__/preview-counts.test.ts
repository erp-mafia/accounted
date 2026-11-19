import { describe, expect, it } from 'vitest'
import { previewCountsForSelection, type ProviderPreviewCounts } from '../preview-counts'

// The crm#1037 shape: five fiscal years at the source, the preview read the
// three default ones.
const READ: ProviderPreviewCounts = {
  accountCount: 400,
  transactionCount: 800,
  fiscalYears: [2024, 2025, 2026],
}

describe('previewCountsForSelection (crm#1037)', () => {
  it('gives the counts while the selection is exactly the years they were read from', () => {
    expect(previewCountsForSelection(READ, [2024, 2025, 2026])).toEqual({ accounts: 400, vouchers: 800 })
  })

  it('ignores order and repeats in the selection', () => {
    expect(previewCountsForSelection(READ, [2026, 2024, 2025, 2024])).toEqual({ accounts: 400, vouchers: 800 })
  })

  it('withholds them when older years are ticked: the three years read are not the five ticked', () => {
    expect(previewCountsForSelection(READ, [2021, 2023, 2024, 2025, 2026])).toBeNull()
  })

  it('withholds them when a read year is unticked: they would still include its vouchers', () => {
    expect(previewCountsForSelection(READ, [2025, 2026])).toBeNull()
  })

  it('withholds them for a selection of the same size that is not the same years', () => {
    expect(previewCountsForSelection(READ, [2023, 2025, 2026])).toBeNull()
  })

  it('withholds them for an empty selection', () => {
    expect(previewCountsForSelection(READ, [])).toBeNull()
  })

  it('withholds them when the preview read nothing', () => {
    expect(previewCountsForSelection(null, [2024, 2025, 2026])).toBeNull()
    expect(previewCountsForSelection(undefined, [2026])).toBeNull()
  })

  it('withholds them when a default year failed to export: it is ticked but was never counted', () => {
    const twoRead: ProviderPreviewCounts = { accountCount: 390, transactionCount: 500, fiscalYears: [2025, 2026] }
    expect(previewCountsForSelection(twoRead, [2024, 2025, 2026])).toBeNull()
    expect(previewCountsForSelection(twoRead, [2025, 2026])).toEqual({ accounts: 390, vouchers: 500 })
  })
})
