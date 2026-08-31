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
 * Operations whose money amount is knowable BEFORE dispatch, with the
 * preview_data field that carries it.
 *
 * An explicit allowlist, not a heuristic search, and derived from what
 * production actually stores (60-day sample): create_voucher carries
 * total_debit on 1 389 of 1 389 rows, categorize_transaction carries amount on
 * 2 002 of 2 003, create_supplier_invoice_from_inbox carries total on 208 of
 * 228.
 *
 * Everything else is unpriceable here and FAILS OPEN. match_batch_allocate,
 * bulk_book_transactions and the link_*_to_voucher settlement paths compute
 * their totals inside SQL during dispatch, so a pre-dispatch check cannot see
 * them. Treating unpriceable as over-limit would silently break batch
 * allocation the day someone sets a limit, which is a worse failure than not
 * enforcing on those paths.
 */
const PRICEABLE_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  create_voucher: ['total_debit'],
  categorize_transaction: ['amount'],
  create_supplier_invoice_from_inbox: ['total'],
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
