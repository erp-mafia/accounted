/**
 * Missing underlag by errand: the ledger's question to the receipt hunt,
 * "of these verifikat without an underlag, what does each one need?".
 *
 * The VAT close check asks it, because not every verifikat without an
 * attached document lacks its underlag: a transfer between the company's own
 * accounts has the bank statement, and one booked from the Stripe feed needs
 * Stripe's report rather than a receipt from a mailbox.
 * The answer is the receipt hunt's (nextStepKind, lib/receipt-hunt/
 * agent-worklist.ts), the same errand its worklist and
 * gnubok_list_verifikat_without_documents give each verifikat. This file is
 * the ledger's side of the contract and imports nothing at runtime; the
 * implementation is wired in lib/composition/missing-underlag-errands.ts,
 * which the ledger imports statically (no lib/init, no event bus).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import type { NextStepKind, VerifikatErrandRow } from '@/lib/receipt-hunt/agent-worklist'

export type { VerifikatErrandRow }

export interface MissingUnderlagErrands {
  /** The module that owns the code behind the answer (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /**
   * The most rows to classify in one question: the receipt hunt's own
   * window. Each read of verifikat_without_documents computes the whole set,
   * so a caller pages up to this many rows and no further.
   */
  readonly maxRows: number
  /**
   * The errand of each verifikat_without_documents row, by journal_entry_id.
   * Throws on a failed read: never an errand that was not read.
   */
  kinds(
    supabase: SupabaseClient,
    companyId: string,
    rows: readonly VerifikatErrandRow[],
  ): Promise<Map<string, NextStepKind>>
}
