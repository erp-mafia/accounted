/**
 * The doors' question (accounted#130 step 2): would this booking of a bank
 * row match one of the company's booking review rules? Every door that books
 * a bank row without a person's review asks here first and refuses, skips or
 * stages a match; commit_journal_entry asks the same in SQL last.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import type { Transaction } from '@/types'
import { bankRowFacts, factsFromLines, matchBookingReviewRules, type BookingReviewRule, type MatchedBookingReviewRule } from './match'
import { loadActiveBookingReviewRules } from './rules'

type BankRow = Pick<Transaction, 'merchant_name' | 'description' | 'amount' | 'amount_sek'> & { original_description?: string | null }
type Line = { account_number: string; debit_amount?: number | string | null; credit_amount?: number | string | null }

/** The rules a booking of these rows with these lines matches. Pass `rules` when a batch read them once. */
export async function matchBookingOfRows(
  supabase: SupabaseClient,
  companyId: string,
  rows: readonly BankRow[],
  lines: readonly Line[],
  rules?: readonly BookingReviewRule[],
): Promise<MatchedBookingReviewRule[]> {
  const active = rules ?? (await loadActiveBookingReviewRules(supabase, companyId))
  if (active.length === 0) return []
  return matchBookingReviewRules(active, factsFromLines(lines, rows.map(bankRowFacts)))
}

/** Whether the commit actor is a person booking from the review: what a matched booking needs. */
export function isPersonReview(actor: CommitActor | undefined): boolean {
  return actor?.type === 'user' && !actor.withoutReview
}
