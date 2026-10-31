/**
 * Hard blocks at the approval doors (accounted#130 step 2, #145).
 *
 * A staged booking of a bank row (categorize_transaction) or a supplier
 * invoice from the Inkorg (create_supplier_invoice_from_inbox) that a booking
 * review rule matches is approved only by a person in the app, one at a
 * time: never through v1, MCP, a grant or a bulk approval. When the company
 * has set booking_review limits (company_attest_limits), the person also
 * needs one that covers the amount. Both refusals come before the operation
 * is claimed (and, for an invoice, before an ankomstnummer is drawn), so it
 * stays pending for the person who may approve it. commit_journal_entry
 * holds the same line in SQL whatever the doors do, and an operation it
 * refuses goes back to pending too (commitPendingOperation). The supplier
 * invoice's judge lives with the doors that ask
 * (lib/pending-operations/staged-booking-review.ts): a bank-row module does
 * not reach into supplier invoices.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PendingOperation } from '@/types'
import { bankRowFacts, matchBookingReviewRules, vatClassesFromLines, vatClassesOfTreatment, type MatchedBookingReviewRule } from './match'
import { loadActiveBookingReviewRules } from './rules'

/** The operation types that book a bank row a rule can match, before their executor runs. */
export const BOOKING_REVIEW_OPERATION_TYPES: ReadonlySet<string> = new Set(['categorize_transaction'])

export interface OperationBookingReview {
  /** The rules that match; empty when what it books could not be judged and the company has rules. */
  matched: MatchedBookingReviewRule[]
  /** The bank row's (or the invoice's) amount in SEK: what a booking_review limit is judged on. */
  amountSek: number
}

type Line = { account_number: string; debit_amount?: number | string | null; credit_amount?: number | string | null }

function previewLines(preview: unknown): Line[] | null {
  const lines = (preview as { lines?: unknown } | null)?.lines
  if (!Array.isArray(lines) || lines.length === 0) return null
  const out: Line[] = []
  for (const line of lines) {
    const account = (line as { account_number?: unknown })?.account_number
    if (typeof account !== 'string') return null
    out.push(line as Line)
  }
  return out
}

/**
 * The rules the staged booking matches, or null when none does (or the
 * operation books no bank row). Judged on the lines its preview shows the
 * approver; a preview without lines is judged on its two accounts and the
 * staged VAT treatment.
 */
export async function operationBookingReview(
  supabase: SupabaseClient,
  companyId: string,
  op: Pick<PendingOperation, 'operation_type' | 'params' | 'preview_data'>,
): Promise<OperationBookingReview | null> {
  if (!BOOKING_REVIEW_OPERATION_TYPES.has(op.operation_type)) return null
  const txId = (op.params as { transaction_id?: unknown } | null)?.transaction_id
  if (typeof txId !== 'string') return null
  const rules = await loadActiveBookingReviewRules(supabase, companyId)
  if (rules.length === 0) return null
  const { data: tx } = await supabase
    .from('transactions')
    .select('merchant_name, original_description, description, amount, amount_sek')
    .eq('id', txId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!tx) return null
  const row = bankRowFacts(tx as Parameters<typeof bankRowFacts>[0])
  const lines = previewLines(op.preview_data)
  const preview = (op.preview_data ?? {}) as { debit_account?: unknown; credit_account?: unknown }
  const facts = lines
    ? { accounts: [...new Set(lines.map((l) => l.account_number))], bankRows: [row], vatClasses: vatClassesFromLines(lines) }
    : {
        accounts: [preview.debit_account, preview.credit_account].filter((a): a is string => typeof a === 'string'),
        bankRows: [row],
        vatClasses: vatClassesOfTreatment((op.params as { vat_treatment?: string | null } | null)?.vat_treatment ?? null),
      }
  const matched = matchBookingReviewRules(rules, facts)
  return matched.length > 0 ? { matched, amountSek: row.amountSek } : null
}

/**
 * Whether the person's booking_review limit covers the amount. No limits set
 * by the company: covered. Limits set, none for the person: not covered.
 */
export async function bookingReviewLimitCovers(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  amountSek: number,
): Promise<{ covered: boolean; limitSek: number | null }> {
  const { data, error } = await supabase
    .from('company_attest_limits')
    .select('user_id, max_amount_sek')
    .eq('company_id', companyId)
    .eq('scope', 'booking_review')
  // An unreadable table refuses nothing here: commit_reviewed_journal_entry
  // checks the same limit in the transaction that posts.
  if (error || !Array.isArray(data) || data.length === 0) return { covered: true, limitSek: null }
  const mine = (data as Array<{ user_id: string; max_amount_sek: number | string | null }>).find((r) => r.user_id === userId)
  if (!mine) return { covered: false, limitSek: null }
  if (mine.max_amount_sek === null) return { covered: true, limitSek: null }
  const limit = Number(mine.max_amount_sek)
  return { covered: limit >= amountSek, limitSek: limit }
}
