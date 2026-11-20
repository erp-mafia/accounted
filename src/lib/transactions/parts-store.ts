/**
 * Writing the Bankgirot split of a bank row (bank_transaction_parts).
 *
 * The parts always mirror the bank's latest word for the row: a store
 * replaces whatever the row had (delete by transaction, then insert), so a
 * re-read that brings a changed split never leaves stale parts behind. A
 * direct table write, not a journal write: the parts are räkenskapsinformation
 * beside the row and book nothing.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { roundOre } from '@/lib/money'
import type { BankTransactionPartInput } from '@/types'
import type { PartSuggestion } from './part-suggestions'

export interface StoreTransactionPartsInput {
  companyId: string
  transactionId: string
  parts: readonly BankTransactionPartInput[]
  /** One per part, in the parts' order (suggestPartInvoices); absent stores the parts unsuggested. */
  suggestions?: readonly PartSuggestion[]
}

/**
 * Replace the row's parts with `parts`. Throws on a refused delete or
 * insert; the caller decides whether that fails anything (ingest does not).
 */
export async function storeTransactionParts(supabase: SupabaseClient, input: StoreTransactionPartsInput): Promise<void> {
  const { companyId, transactionId, parts, suggestions } = input
  const { error: deleteError } = await supabase
    .from('bank_transaction_parts')
    .delete()
    .eq('company_id', companyId)
    .eq('transaction_id', transactionId)
  if (deleteError) throw new Error(`bank_transaction_parts delete refused: ${deleteError.message}`)
  if (parts.length === 0) return

  const rows = parts.map((part, index) => {
    const suggestion = suggestions?.[index]
    return {
      company_id: companyId,
      transaction_id: transactionId,
      seq: index + 1,
      amount: roundOre(part.amount),
      currency: (part.currency || 'SEK').toUpperCase(),
      counterparty_name: part.counterparty_name ?? null,
      counterparty_org_number: part.counterparty_org_number ?? null,
      counterparty_account: part.counterparty_account ?? null,
      reference: part.reference ?? null,
      invoice_numbers: part.invoice_numbers ?? [],
      message: part.message ?? null,
      provider_part_id: part.provider_part_id ?? null,
      suggested_invoice_id: suggestion?.suggested_invoice_id ?? null,
      suggested_supplier_invoice_id: suggestion?.suggested_supplier_invoice_id ?? null,
      suggestion_reason: suggestion?.suggestion_reason ?? null,
    }
  })
  const { error: insertError } = await supabase.from('bank_transaction_parts').insert(rows)
  if (insertError) throw new Error(`bank_transaction_parts insert refused: ${insertError.message}`)
}
