/**
 * Approval-authority limit: what an API key may commit WITHOUT a human.
 *
 * This is not a write limit. Over the ceiling the operation stays staged and a
 * person approves it in /pending, so nothing is destroyed, no voucher number is
 * burned, and no löpnummer gap appears (BFL 5 kap. 7 §).
 *
 * ## What this control is, and is not
 *
 * It is a blast-radius cap on an agent that is looping, mis-prompted or
 * prompt-injected. It is NOT a security boundary: a per-entry ceiling is
 * defeated by splitting one large entry into several small ones, and an LLM
 * will discover that on its own, because "reduce the amount and retry" is the
 * obvious repair for "amount too large".
 *
 * That bypass is itself a compliance violation, since one affärshändelse is one
 * verifikat (BFL 5 kap. 6 §), which is why the UNATTENDED_COMMIT_LIMIT_EXCEEDED
 * remediation tells the agent not to split BEFORE it tells it anything else.
 * A rolling-window cumulative limit is the primitive that actually bounds
 * exposure; it is deliberately a separate change.
 */

/**
 * Every operation type that posts money, with the preview_data field carrying
 * the amount it will post.
 *
 * An explicit allowlist, and every entry is verified against production rather
 * than guessed. Over the last 120 days each field below is present and numeric
 * on 100% of that type's staged rows:
 *
 *   create_voucher                    total_debit         1389 rows
 *   categorize_transaction            amount              2003 rows
 *   create_supplier_invoice_from_inbox total               228 rows
 *   link_transaction_journal_entry    transaction_amount  1369 rows
 *   bulk_book_transactions            tx_sum               273 rows
 *   link_supplier_invoice_voucher     payment_amount        55 rows
 *   match_batch_allocate              total_allocated       24 rows
 *   mark_invoice_paid                 total                  3 rows
 *
 * The staged preview already carries the amount the operation intends to post,
 * because that is the number a human is shown when approving it. An earlier
 * draft of this file assumed the batch and settlement paths computed their
 * totals only inside SQL at dispatch and therefore left them unpriced; that was
 * wrong, and it left the four largest settlement paths able to post any amount
 * on a key with a ceiling.
 *
 * Types deliberately absent, and why:
 *   - reconciliation_match carries pair_count, a COUNT, not an amount. Pricing
 *     it off that number would compare pairs against kronor. It stays unpriced.
 *   - link_document_to_voucher and attach_document_to_transaction move no
 *     money; they attach räkenskapsinformation to something already booked.
 *   - create_customer, create_transaction and the rest of the registry post
 *     nothing to the ledger.
 *
 * Anything not listed is unpriceable and FAILS OPEN. That is the safe direction
 * for a control that can only ever narrow what a key does: a wrong guess at an
 * amount blocks a legitimate commit, and the failure mode of guessing high is
 * an agent that cannot work at all.
 */
const PRICEABLE_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  create_voucher: ['total_debit'],
  categorize_transaction: ['amount'],
  create_supplier_invoice_from_inbox: ['total'],
  link_transaction_journal_entry: ['transaction_amount'],
  bulk_book_transactions: ['tx_sum'],
  link_supplier_invoice_voucher: ['payment_amount'],
  match_batch_allocate: ['total_allocated'],
  mark_invoice_paid: ['total'],
}

/**
 * The SEK amount this operation would post, or null when it cannot be priced
 * before dispatch.
 *
 * Null always means "do not enforce". Every parse failure, missing field and
 * unknown operation type lands here on purpose.
 */
export function priceOperation(
  operationType: string,
  previewData: unknown,
): number | null {
  const fields = PRICEABLE_OPERATIONS[operationType]
  if (!fields) return null
  if (previewData === null || typeof previewData !== 'object') return null

  const record = previewData as Record<string, unknown>
  for (const field of fields) {
    const raw = record[field]
    if (raw === null || raw === undefined) continue
    // jsonb numerics can arrive as strings; parse rather than trusting
    // comparison coercion.
    const parsed = typeof raw === 'number' ? raw : Number(raw)
    if (Number.isFinite(parsed)) return Math.abs(parsed)
  }
  return null
}

/**
 * True when this commit needs a human first.
 *
 * Written NULL-first in every clause. Absence of a limit, absence of a price,
 * and any non-api_key actor all return false, so the control can only ever
 * narrow what an API key does unattended and can never touch a human, a cron
 * or an in-app approval.
 */
export function exceedsUnattendedLimit(params: {
  actorType: string | undefined
  limit: number | null | undefined
  operationType: string
  previewData: unknown
}): { exceeded: boolean; attempted: number | null; limit: number | null } {
  const limit =
    typeof params.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
      ? params.limit
      : null

  if (params.actorType !== 'api_key' || limit === null) {
    return { exceeded: false, attempted: null, limit }
  }

  const attempted = priceOperation(params.operationType, params.previewData)
  if (attempted === null) return { exceeded: false, attempted: null, limit }

  return { exceeded: attempted > limit, attempted, limit }
}
