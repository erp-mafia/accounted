/**
 * Unbooked bank lines: the ledger's question to the bank side, "which bank
 * lines dated in this range still owe the books a verifikat?".
 *
 * The report data status asks it here; the period lock guard
 * (countUnbookedInPeriod) and the VAT close check still read
 * lib/transactions/unbooked.ts directly. The answer is the bank transactions
 * block's: one definition of "no bookkeeping" shared by all of them and the
 * attention resource. This file is the ledger's side of the
 * contract and imports nothing at runtime; the implementation is wired in
 * lib/composition/unbooked-bank-lines.ts, which the ledger imports
 * statically (no lib/init, no event bus).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'

export interface UnbookedBankLineCount {
  total: number
  /** Never triaged: is_business IS NULL AND is_ignored = false. */
  untriaged: number
  /** Triaged as a business event but anchored to no verifikat at all. */
  business_unbooked: number
}

export interface UnbookedBankLineRange {
  /** Inclusive YYYY-MM-DD lower bound on the bank line's date. */
  fromDate?: string
  /** Inclusive YYYY-MM-DD upper bound on the bank line's date. */
  toDate?: string
}

export interface UnbookedBankLines {
  /** The module that owns the code behind the answer (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /**
   * Count the company's unbooked bank lines, optionally inside a date range.
   * Throws on any query failure so a caller can fail closed: never 0 for a
   * check that did not run.
   */
  count(supabase: SupabaseClient, companyId: string, range?: UnbookedBankLineRange): Promise<UnbookedBankLineCount>
}
