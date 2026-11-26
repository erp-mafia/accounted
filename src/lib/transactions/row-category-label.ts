import { getCategoryDisplayName } from '@/lib/tax/expense-warnings'
import { getLinkedJournalEntryIds, type EmbeddedVoucherLink } from '@/lib/transactions/is-booked'

export interface RowCategoryLabelInput {
  is_business: boolean | null
  category: string
  journal_entry_id: string | null
  transaction_voucher_links?: EmbeddedVoucherLink[] | null
}

/**
 * The muted category chip beside a bank row's title in the transaction
 * list, or null for none. Business rows only. A booked row whose category
 * was never set ('uncategorized', whose display name is "Ej bokförd") gets
 * no chip: the status column already says Bokförd.
 *
 * Booked is getLinkedJournalEntryIds, the pointer or a bank_line junction
 * row. Reading the pointer alone showed "Ej bokförd" beside "Bokförd" on a
 * row booked into a samlingsverifikat (several bank rows, one verifikat).
 * Pure and client-safe.
 */
export function bankRowCategoryLabel(tx: RowCategoryLabelInput): string | null {
  if (tx.is_business !== true) return null
  if (tx.category === 'uncategorized' && getLinkedJournalEntryIds(tx).length > 0) return null
  return getCategoryDisplayName(tx.category)
}
