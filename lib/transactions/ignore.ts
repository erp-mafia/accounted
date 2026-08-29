/**
 * Shared core for "ignore a bank transaction" (issue #1661).
 *
 * Ignoring is the legal escape hatch for a bank row that is not an
 * affärshändelse (a PSD2 ghost row, a duplicate from a reconnect, a transfer
 * that never executed): it writes no verifikat, so BFL 5 kap. does not apply
 * and a locked or closed period does not block it. A private marking, by
 * contrast, IS a booking (eget uttag/insättning, or 2893 for an AB) and stays
 * subject to the period lock.
 *
 * Three doors call this one function so they cannot drift:
 *   - the dashboard route (app/api/transactions/[id]/ignore)
 *   - the v1 REST verb (app/api/v1/.../transactions/[id]/ignore)
 *   - the MCP executor for the staged ignore_transaction operation
 *     (lib/pending-operations/commit.ts)
 *
 * "Already booked" is decided by isTransactionBooked(): a bulk-booked or
 * multi-allocated row keeps transactions.journal_entry_id NULL and is anchored
 * through transaction_voucher_links / invoice_payments /
 * supplier_invoice_payments instead. A bare journal_entry_id check would let
 * those rows be ignored while a verifikat still carries them.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isTransactionBooked } from '@/lib/transactions/is-booked'

export type TransactionIgnoreRefusalCode = 'TX_CATEGORIZE_TX_NOT_FOUND' | 'TX_IGNORE_ALREADY_BOOKED'

export type SetTransactionIgnoredOutcome =
  | {
      ok: true
      transaction_id: string
      is_ignored: boolean
      /** false when the row was already in the requested state (idempotent no-op). */
      changed: boolean
      /** true when the caller asked for a dry run: nothing was written. */
      dry_run: boolean
    }
  | {
      ok: false
      code: TransactionIgnoreRefusalCode
      status: 404 | 409
    }

interface TransactionIgnoreRow {
  id: string
  journal_entry_id: string | null
  is_ignored: boolean | null
}

/** Re-throw a PostgREST error as an Error that keeps its SQLSTATE for getErrorMessage. */
function toThrowable(error: { message: string; code?: string; details?: string; hint?: string }): Error {
  return Object.assign(new Error(error.message), {
    code: error.code,
    details: error.details,
    hint: error.hint,
  })
}

/**
 * Set or clear the ignore flag on one bank transaction.
 *
 * - Unknown row in this company: `{ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }`.
 * - `ignored = true` on a booked row (any of the three anchors):
 *   `{ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED' }`. Restoring
 *   (`ignored = false`) needs no such check: the DB CHECK
 *   `transactions_is_ignored_no_journal_entry` already guarantees an ignored
 *   row is unbooked.
 * - Same state as requested: `{ ok: true, changed: false }` (idempotent).
 * - Database failures throw; callers map them through lib/errors.
 */
export async function setTransactionIgnored(
  supabase: SupabaseClient,
  companyId: string,
  transactionId: string,
  ignored: boolean,
  options: { dryRun?: boolean } = {},
): Promise<SetTransactionIgnoredOutcome> {
  const { data: tx, error: fetchError } = await supabase
    .from('transactions')
    .select('id, journal_entry_id, is_ignored')
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<TransactionIgnoreRow>()
  if (fetchError) throw toThrowable(fetchError)
  if (!tx) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND', status: 404 }

  if (ignored) {
    let booked = tx.journal_entry_id != null
    if (!booked) {
      // The two junction shapes that keep journal_entry_id NULL on the row.
      const [voucherLinks, invoicePayments, supplierPayments] = await Promise.all([
        supabase
          .from('transaction_voucher_links')
          .select('transaction_id')
          .eq('transaction_id', tx.id)
          .limit(1),
        supabase.from('invoice_payments').select('transaction_id').eq('transaction_id', tx.id).limit(1),
        supabase
          .from('supplier_invoice_payments')
          .select('transaction_id')
          .eq('transaction_id', tx.id)
          .limit(1),
      ])
      if (voucherLinks.error) throw toThrowable(voucherLinks.error)
      if (invoicePayments.error) throw toThrowable(invoicePayments.error)
      if (supplierPayments.error) throw toThrowable(supplierPayments.error)
      booked = isTransactionBooked(
        tx,
        [...(invoicePayments.data ?? []), ...(supplierPayments.data ?? [])],
        voucherLinks.data ?? [],
      )
    }
    if (booked) return { ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 }
  }

  const alreadyInState = Boolean(tx.is_ignored) === ignored
  if (alreadyInState || options.dryRun) {
    return {
      ok: true,
      transaction_id: tx.id,
      is_ignored: ignored,
      changed: !alreadyInState,
      dry_run: Boolean(options.dryRun),
    }
  }

  const { error: updateError } = await supabase
    .from('transactions')
    .update({ is_ignored: ignored })
    .eq('id', transactionId)
    .eq('company_id', companyId)
  if (updateError) throw toThrowable(updateError)

  return { ok: true, transaction_id: tx.id, is_ignored: ignored, changed: true, dry_run: false }
}
