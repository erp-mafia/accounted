import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import { escapeLikePattern } from '@/lib/supabase/like-pattern'

/** Rows one picker request returns, with or without a search term. */
export const OUTGOING_PICKER_LIMIT = 200

export interface UnmatchedOutgoingTransaction {
  id: string
  date: string
  description: string
  amount: number
  currency: string
}

/**
 * Outgoing bank rows a supplier invoice can be registered as paid by: a
 * negative amount, no verifikat and no invoice or supplier invoice link yet.
 *
 * The picker (components/transactions/BankTransactionPicker) used to load the
 * newest OUTGOING_PICKER_LIMIT rows and filter them in the browser, so a
 * search could never find an older payment: it was simply not in the list. A
 * search term now goes to the database and matches the description across
 * every unmatched outgoing row, as the open-invoice picker does
 * (lib/invoices/open-invoice-search); without a term the newest rows make the
 * default view. `capped` says the answer came back full.
 */
export async function searchUnmatchedOutgoingTransactions(
  supabase: SupabaseDataClient,
  companyId: string,
  term: string,
): Promise<{ rows: UnmatchedOutgoingTransaction[]; capped: boolean }> {
  const trimmed = term.trim()
  let query = supabase
    .from('transactions')
    .select('id, date, description, amount, currency')
    .eq('company_id', companyId)
    .lt('amount', 0)
    .is('journal_entry_id', null)
    .is('supplier_invoice_id', null)
    .is('invoice_id', null)
  if (trimmed) query = query.ilike('description', `%${escapeLikePattern(trimmed)}%`)
  const { data, error } = await query
    .order('date', { ascending: false })
    .order('id', { ascending: true })
    .limit(OUTGOING_PICKER_LIMIT)
  if (error) throw new Error(error.message)
  const rows = (data as UnmatchedOutgoingTransaction[] | null) ?? []
  return { rows, capped: rows.length >= OUTGOING_PICKER_LIMIT }
}
