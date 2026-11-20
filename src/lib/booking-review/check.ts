/**
 * The doors' question (accounted#130 step 2): would this booking of a bank
 * row match one of the company's booking review rules? Every door that books
 * a bank row without a person's review asks here first and refuses, skips or
 * stages a match; commit_journal_entry asks the same in SQL last.
 */
import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CommitActor } from '@/lib/bookkeeping/actor-context'
import type { Transaction } from '@/types'
import {
  bankRowFacts,
  factsFromLines,
  grantCounterpartyKey,
  matchBookingReviewRules,
  type BookingReviewRule,
  type MatchedBookingReviewRule,
} from './match'
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

/** A supplier invoice as a settlement without a person reads it, with its supplier and items. */
type SettledInvoice = {
  registration_journal_entry_id?: string | null
  total: number | string
  total_sek?: number | string | null
  exchange_rate?: number | string | null
  supplier?: { name?: string | null } | null
  items?: ReadonlyArray<{ account_number?: string | null; accrual_balance_account?: string | null }> | null
}

/**
 * Whether settling this supplier invoice without a person may book what a
 * block holds (accounted#145). Only a settlement that books the purchase
 * itself can: an invoice with no registration verifikat (kontantmetoden, or
 * deferred booking registered first). Judged on the supplier and the bank
 * row, the invoice amount and the items' accounts, with its VAT unknown, so
 * any VAT criterion counts as met. A door that runs without a person (a bank
 * payment order's own debit) leaves such a settlement to a person instead of
 * drafting a verifikat commit_journal_entry refuses on every run.
 */
export async function unattendedSettlementMayMatch(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SettledInvoice,
  row: BankRow,
): Promise<boolean> {
  if (invoice.registration_journal_entry_id) return false
  const rules = await loadActiveBookingReviewRules(supabase, companyId)
  if (rules.length === 0) return false
  const amountSek = Math.abs(Number(invoice.total_sek ?? sekOfForeign(Number(invoice.total), Number(invoice.exchange_rate) || 1)) || 0)
  const accounts = new Set<string>()
  for (const item of invoice.items ?? []) {
    for (const account of [item.account_number, item.accrual_balance_account]) if (account) accounts.add(account)
  }
  const matched = matchBookingReviewRules(rules, {
    accounts: [...accounts],
    bankRows: [bankRowFacts(row), { counterpartyKey: grantCounterpartyKey(invoice.supplier?.name, null, null), amountSek }],
    vatClasses: null,
  })
  return matched.length > 0
}
