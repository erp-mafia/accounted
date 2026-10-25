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
 *
 * One booked shape is ignorable (PH 214): a row the user created whose
 * verifikat books no bank line (lib/transactions/stale-bank-anchor.ts). Its
 * link is dropped in the same write and logged as unmatched; the verifikat
 * stays exactly as it is.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { isTransactionBooked } from '@/lib/transactions/is-booked'
import { findStaleBankAnchors, type StaleAnchorRow } from '@/lib/transactions/stale-bank-anchor'
import { recordDecisions, snapshotSuggestions } from '@/lib/suggestion-log/record'
import { passed } from '@/lib/suggestion-log/checks'

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

interface TransactionIgnoreRow extends StaleAnchorRow {
  is_ignored: boolean | null
  reconciliation_method?: string | null
}

/**
 * Set or clear the ignore flag on one bank transaction.
 *
 * - Unknown row in this company: `{ ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND' }`.
 * - `ignored = true` on a booked row (any of the three anchors):
 *   `{ ok: false, code: 'TX_IGNORE_ALREADY_BOOKED' }`, unless the row is the
 *   stale shape above: then its pointer is cleared with the flag. Restoring
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
  /** userId: who decided, recorded with the dismissal in suggestion_log. */
  options: { dryRun?: boolean; userId?: string } = {},
): Promise<SetTransactionIgnoredOutcome> {
  const { data: tx, error: fetchError } = await supabase
    .from('transactions')
    .select(
      'id, journal_entry_id, is_ignored, reconciliation_method, cash_account_id, currency, amount, bank_connection_id, import_source, invoice_id, supplier_invoice_id',
    )
    .eq('id', transactionId)
    .eq('company_id', companyId)
    .maybeSingle<TransactionIgnoreRow>()
  if (fetchError) throw dbError(fetchError, null)
  if (!tx) return { ok: false, code: 'TX_CATEGORIZE_TX_NOT_FOUND', status: 404 }

  // The pointer this write clears: set only for a row whose verifikat books
  // no bank line (PH 214), and only with a person to record the unlink for.
  let release: { entryId: string; userId: string } | null = null
  if (ignored) {
    let booked = tx.journal_entry_id != null
    if (booked) {
      if (options.userId && tx.journal_entry_id && (await findStaleBankAnchors(supabase, companyId, [tx])).has(tx.id)) {
        release = { entryId: tx.journal_entry_id, userId: options.userId }
        booked = false
      }
    } else {
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
      if (voucherLinks.error) throw dbError(voucherLinks.error, null)
      if (invoicePayments.error) throw dbError(invoicePayments.error, null)
      if (supplierPayments.error) throw dbError(supplierPayments.error, null)
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

  // Ignoring is a decision on the bank line: what was on offer is recorded
  // as dismissed. Restoring the row is not a decision on any suggestion.
  const suggestionSnapshot = ignored ? await snapshotSuggestions(supabase, companyId, [tx.id]) : null

  if (release) {
    // Compare-and-set on the pointer read above: a concurrent link or storno wins.
    const { data: released, error: releaseError } = await supabase
      .from('transactions')
      .update({ is_ignored: true, journal_entry_id: null, reconciliation_method: null, is_business: null })
      .eq('id', transactionId)
      .eq('company_id', companyId)
      .eq('journal_entry_id', release.entryId)
      .select('id')
    if (releaseError) throw dbError(releaseError, null)
    if (!released || released.length === 0) return { ok: false, code: 'TX_IGNORE_ALREADY_BOOKED', status: 409 }
    // Behandlingshistorik: the link removal lands in the append-only
    // payment_match_log, as every Koppla bort does (unlinkReconciliation).
    // The row logMatchEvent (lib/invoices/match-log.ts) writes, inline: that
    // helper lives in another module. Never fails the ignore, like it.
    try {
      await supabase.from('payment_match_log').insert({
        user_id: release.userId,
        transaction_id: tx.id,
        invoice_id: null,
        supplier_invoice_id: null,
        action: 'unmatched',
        match_confidence: null,
        match_method: null,
        previous_state: {
          journal_entry_id: release.entryId,
          reconciliation_method: tx.reconciliation_method ?? null,
          reason: 'verifikat_books_no_bank_line',
        },
        new_state: { is_ignored: true },
      })
    } catch {
      // Non-critical, as in logMatchEvent.
    }
  } else {
    const { error: updateError } = await supabase
      .from('transactions')
      .update({ is_ignored: ignored })
      .eq('id', transactionId)
      .eq('company_id', companyId)
    if (updateError) throw dbError(updateError, null)
  }

  if (suggestionSnapshot) {
    // Ignoring ran one guard: the row was not booked.
    await recordDecisions(
      supabase,
      suggestionSnapshot,
      [{ transactionId: tx.id, final: null, checks: [passed('already_booked')] }],
      options.userId ?? null,
    )
  }

  return { ok: true, transaction_id: tx.id, is_ignored: ignored, changed: true, dry_run: false }
}
