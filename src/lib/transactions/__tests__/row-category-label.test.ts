import { describe, it, expect } from 'vitest'
import { bankRowCategoryLabel } from '../row-category-label'

const JE = '00000000-0000-4000-8000-000000000032'

describe('bankRowCategoryLabel', () => {
  it('shows no "Ej bokförd" chip on a row booked through a bank_line voucher link', () => {
    // Two salary bank rows booked into one verifikat: the pointer stays NULL,
    // each row is anchored by a bank_line junction row, category never set.
    const row = {
      is_business: true,
      category: 'uncategorized',
      journal_entry_id: null,
      transaction_voucher_links: [{ journal_entry_id: JE, role: 'bank_line' }],
    }
    expect(bankRowCategoryLabel(row)).toBeNull()
  })

  it('treats a link without a role as bank_line, as getLinkedJournalEntryIds does', () => {
    const row = {
      is_business: true,
      category: 'uncategorized',
      journal_entry_id: null,
      transaction_voucher_links: [{ journal_entry_id: JE }],
    }
    expect(bankRowCategoryLabel(row)).toBeNull()
  })

  it('shows no chip on an uncategorized row booked through the pointer', () => {
    expect(
      bankRowCategoryLabel({ is_business: true, category: 'uncategorized', journal_entry_id: JE }),
    ).toBeNull()
  })

  it('still shows "Ej bokförd" on an unbooked business row', () => {
    expect(
      bankRowCategoryLabel({
        is_business: true,
        category: 'uncategorized',
        journal_entry_id: null,
        transaction_voucher_links: [],
      }),
    ).toBe('Ej bokförd')
  })

  it('does not count a residual (clearing) link as booking the row', () => {
    expect(
      bankRowCategoryLabel({
        is_business: true,
        category: 'uncategorized',
        journal_entry_id: null,
        transaction_voucher_links: [{ journal_entry_id: JE, role: 'clearing' }],
      }),
    ).toBe('Ej bokförd')
  })

  it('keeps the category chip on a booked row with a category', () => {
    expect(
      bankRowCategoryLabel({
        is_business: true,
        category: 'expense_software',
        journal_entry_id: null,
        transaction_voucher_links: [{ journal_entry_id: JE, role: 'bank_line' }],
      }),
    ).toBe('Programvara')
  })

  it('shows no chip on a private or unclassified row', () => {
    expect(bankRowCategoryLabel({ is_business: false, category: 'private', journal_entry_id: null })).toBeNull()
    expect(bankRowCategoryLabel({ is_business: null, category: 'uncategorized', journal_entry_id: null })).toBeNull()
  })
})
