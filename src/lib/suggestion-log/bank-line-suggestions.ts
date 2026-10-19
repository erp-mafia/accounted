/**
 * Bank-line suggestions: the decision log's question to the bank side,
 * "what did you offer on these bank lines, under which rules, and how does
 * your approval policy band each offer?".
 *
 * The suggestion log records every decision on a bank line next to what was
 * on offer (./record.ts, ./classify.ts). The offers, the revision of the
 * rules behind them and the direct-booking policy are the bank transactions
 * block's (lib/transactions/propose.ts, lib/transactions/direct-booking.ts).
 * This file is the log's side of the contract and imports nothing at
 * runtime; the implementation is wired in
 * lib/composition/bank-line-suggestions.ts, which the log imports
 * statically (no lib/init, no event bus).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import type { AssistantRead } from '@/lib/agent/categorize/read-shape'
import type { Transaction } from '@/types'

/** direct: the row's Bokför books it without a review. review: it opens Granska bokföring. */
export type ConfidenceBand = 'direct' | 'review'

export interface BankLineOffers {
  proposals: Record<string, BookingProposal[]>
  /** The fresh stored assistant read behind each row, by transaction id. */
  assistant_reads: Record<string, AssistantRead>
}

export interface BankLineSuggestions {
  /** The module that owns the code behind the answers (lib/modules/manifest.ts). */
  readonly module: ModuleId
  /** The revision of the rules the offers come from (suggestion_log.rule_version, with the program version). */
  rulesRevision(): string
  /** The approval policy a band is evaluated under (suggestion_log.policy_version). */
  policyVersion(): string
  /** What the bank side offers for the rows right now, in its order. */
  propose(supabase: SupabaseClient, companyId: string, transactions: Transaction[]): Promise<BankLineOffers>
  /** The band an offer falls in under policyVersion(). */
  confidenceBand(proposal: BookingProposal): ConfidenceBand
}
