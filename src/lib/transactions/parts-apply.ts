/**
 * Applying a Bankgirot split to a stored bank row: store the parts beside
 * the row (storeTransactionParts), suggest the open invoice behind each part
 * (suggestPartInvoices) for a row a person has not yet decided, and mark the
 * row when the split explains it.
 *
 * Two doors bring a split: Open Payments' enrichment during ingest
 * (lib/transactions/ingest.ts) and Bankgirot's own deposit specification, the
 * BG Max file (lib/import/bgmax/attach.ts, crm#1170). Both go through here so
 * a split means the same thing whichever door it came through.
 *
 * When two or more parts all resolved and sum to the row, the row is marked
 * potential_match_method = 'bankgiro_split' and a single-invoice hint it
 * carried is cleared: the row pays several invoices, so the one-click single
 * match would only be refused. Suggestion only: nothing here books. Never
 * touches the row's amount, date or text.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { logMatchEvent } from '@/lib/invoices/match-log'
import type { MatchableInvoice } from '@/lib/invoices/invoice-matching'
import type { BankTransactionPartInput, SupplierInvoice, Transaction } from '@/types'
import {
  BANKGIRO_SPLIT_CONFIDENCE,
  BANKGIRO_SPLIT_METHOD,
  splitIsComplete,
  suggestPartInvoices,
  type PartSuggestion,
} from './part-suggestions'
import { storeTransactionParts } from './parts-store'

/** The row fields the split reads. */
export type SplitRow = Pick<Transaction, 'id' | 'amount'> &
  Partial<Pick<Transaction, 'potential_journal_entry_id' | 'potential_match_method'>>

export interface SplitSuggestionPools {
  /** The company's open customer invoices (loadInvoiceMatchPool), for a deposit. */
  customerInvoices: readonly MatchableInvoice[]
  /** The company's open supplier invoices, for a payout. */
  supplierInvoices: readonly SupplierInvoice[]
  /** Invoices another row already claims: never offered again. */
  excludeInvoiceIds?: ReadonlySet<string>
}

export interface ApplySplitInput {
  companyId: string
  userId: string
  tx: SplitRow
  parts: readonly BankTransactionPartInput[]
  /**
   * The pools to suggest from; null for a row a person already decided
   * (booked, linked, ignored), whose parts are stored without suggestions.
   */
  pools: SplitSuggestionPools | null
}

export interface ApplySplitResult {
  /** One per part, in the parts' order; null when the row got no suggestions. */
  suggestions: PartSuggestion[] | null
  /** True when the split explains the whole row and the row was marked. */
  complete: boolean
}

/**
 * Store the split and suggest from it. Throws when a write is refused; the
 * caller decides whether that fails anything.
 */
export async function applyTransactionSplit(supabase: SupabaseClient, input: ApplySplitInput): Promise<ApplySplitResult> {
  const { companyId, userId, tx, parts, pools } = input
  const suggestions = pools
    ? suggestPartInvoices({
        parentAmount: tx.amount,
        parts,
        customerInvoices: tx.amount > 0 ? pools.customerInvoices : [],
        supplierInvoices: tx.amount < 0 ? pools.supplierInvoices : [],
        excludeInvoiceIds: pools.excludeInvoiceIds,
      })
    : undefined
  await storeTransactionParts(supabase, { companyId, transactionId: tx.id, parts, suggestions })
  if (!suggestions) return { suggestions: null, complete: false }

  const complete = splitIsComplete(tx.amount, parts, suggestions)
  // A voucher suggestion (potential_journal_entry_id) owns the method and
  // confidence columns: the split never writes over it.
  const marker = !tx.potential_journal_entry_id
  if (!complete) {
    if (marker && tx.potential_match_method === BANKGIRO_SPLIT_METHOD) {
      // The split no longer explains the row (an invoice closed another
      // way, the bank changed the parts): the marker goes, the parts stay.
      await supabase
        .from('transactions')
        .update({ potential_match_method: null, potential_match_confidence: null })
        .eq('id', tx.id)
        .eq('company_id', companyId)
    }
    return { suggestions, complete: false }
  }

  const allocations = suggestions.map((s, index) => ({
    seq: s.seq,
    amount: Math.abs(parts[index]!.amount),
    ...(s.suggested_invoice_id ? { invoice_id: s.suggested_invoice_id } : {}),
    ...(s.suggested_supplier_invoice_id ? { supplier_invoice_id: s.suggested_supplier_invoice_id } : {}),
  }))
  // Two literal payloads rather than one spread: the schema guard
  // (tests/schema/no-phantom-columns) can only check columns it can read.
  const marking = marker
    ? supabase.from('transactions').update({
        potential_match_method: BANKGIRO_SPLIT_METHOD,
        potential_match_confidence: BANKGIRO_SPLIT_CONFIDENCE,
        potential_invoice_id: null,
        potential_supplier_invoice_id: null,
      })
    : supabase.from('transactions').update({ potential_invoice_id: null, potential_supplier_invoice_id: null })
  const { error: markError } = await marking.eq('id', tx.id).eq('company_id', companyId)
  if (markError) throw markError
  await logMatchEvent(supabase, userId, tx.id, 'auto_suggested', {
    matchConfidence: BANKGIRO_SPLIT_CONFIDENCE,
    matchMethod: BANKGIRO_SPLIT_METHOD,
    newState: { allocations },
  })
  return { suggestions, complete: true }
}
