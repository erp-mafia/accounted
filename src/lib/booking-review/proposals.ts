/**
 * Booking review rules on a bank row's suggestions (accounted#130 step 2).
 * A suggestion has no lines yet, so it is judged on the accounts it names
 * (both legs and a learned pattern's lines) and on the VAT its treatment
 * books; a suggestion with no treatment counts as meeting any VAT criterion,
 * so it asks. The booking itself is judged again on its lines by
 * commit_journal_entry. Pure.
 */
import type { BookingProposal } from '@/lib/bookkeeping/proposal'
import type { Transaction } from '@/types'
import {
  bankRowFacts,
  matchBookingReviewRules,
  vatClassesFromLines,
  vatClassesOfTreatment,
  type BookingReviewFacts,
  type BookingReviewRule,
  type BookingReviewVatClass,
} from './match'

/** What a suggestion for the row would book, as a rule judges it. */
export function proposalFacts(
  proposal: Pick<BookingProposal, 'debit_account' | 'credit_account' | 'line_pattern' | 'vat_treatment' | 'booking'>,
  tx: Pick<Transaction, 'merchant_name' | 'description' | 'amount' | 'amount_sek'> & { original_description?: string | null },
): BookingReviewFacts {
  const accounts = [
    proposal.debit_account,
    proposal.credit_account,
    ...(proposal.line_pattern ?? []).map((line) => line.account),
    ...(proposal.booking.kind === 'account' ? [proposal.booking.account] : []),
  ].filter((a): a is string => typeof a === 'string' && a.length > 0)
  const treatment = proposal.vat_treatment ?? (proposal.booking.kind === 'account' ? proposal.booking.vat_treatment : null)
  return {
    accounts: [...new Set(accounts)],
    bankRows: [bankRowFacts(tx)],
    vatClasses: vatClassesOfTreatment(treatment) ?? patternVatClasses(proposal.line_pattern),
  }
}

/**
 * The VAT a learned pattern books, read off its lines as vatClassesFromLines
 * reads a verifikat's: its VAT lines' accounts and rates. Null without a
 * pattern (not known: any VAT criterion counts as met).
 */
function patternVatClasses(pattern: BookingProposal['line_pattern']): BookingReviewVatClass[] | null {
  if (!pattern || pattern.length === 0) return null
  const classes = new Set<BookingReviewVatClass>()
  for (const line of pattern) {
    if (line.type !== 'vat') continue
    const fromAccount = vatClassesFromLines([{ account_number: line.account, debit_amount: 0, credit_amount: 0 }])
    if (fromAccount[0] !== 'none') {
      for (const c of fromAccount) classes.add(c)
      continue
    }
    const rate = Number(line.vat_rate)
    if (!Number.isFinite(rate) || rate <= 0) return null
    classes.add(rate >= 0.185 ? 'standard_25' : rate >= 0.09 ? 'reduced_12' : 'reduced_6')
  }
  return classes.size === 0 ? ['none'] : [...classes].sort()
}

/** The row's proposals, each one a rule matches marked review_blocked. */
export function markBlockedProposals(
  proposals: BookingProposal[],
  tx: Pick<Transaction, 'merchant_name' | 'description' | 'amount' | 'amount_sek'> & { original_description?: string | null },
  rules: readonly BookingReviewRule[],
): BookingProposal[] {
  if (rules.length === 0) return proposals
  return proposals.map((proposal) =>
    matchBookingReviewRules(rules, proposalFacts(proposal, tx)).length > 0 ? { ...proposal, review_blocked: true } : proposal,
  )
}
