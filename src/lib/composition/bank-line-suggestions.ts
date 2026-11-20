/**
 * The bank side's answers to the decision log's "what did you offer on
 * these bank lines, under which rules, and how does your policy band each
 * offer?" (contract: lib/suggestion-log/bank-line-suggestions.ts). Written
 * out by hand and imported statically by the log: no lazy loading, no
 * lib/init, no event bus.
 *
 * Each member calls a function the transactions block already had, or reads
 * its constant, unchanged and at the moment the log read it before the
 * plug-in point existed.
 */
import type { BankLineSuggestions } from '@/lib/suggestion-log/bank-line-suggestions'
import { BANK_PROPOSAL_RULES_REVISION, proposeForTransactions } from '@/lib/transactions/propose'
import { confidenceBand, DIRECT_BOOKING_POLICY_VERSION } from '@/lib/transactions/direct-booking'

export const BANK_LINE_SUGGESTIONS: BankLineSuggestions = Object.freeze<BankLineSuggestions>({
  module: 'transactions',
  rulesRevision: () => BANK_PROPOSAL_RULES_REVISION,
  policyVersion: () => DIRECT_BOOKING_POLICY_VERSION,
  propose: (...args) => proposeForTransactions(...args),
  confidenceBand: (proposal, directBooking) => confidenceBand(proposal, directBooking),
})
