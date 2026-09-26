import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { invoiceCustomerOutstanding } from '@/lib/invoices/customer-share'
import type { JournalEntry } from '@/types'

const log = createLogger('payment-sync')

// The list itself lives in lib/bookkeeping/payment-source-types.ts, because the
// unlink control in the supplier-invoice page needs it client-side and must not
// pull this file's Supabase server imports along.
//
// isPaymentSourceType is imported rather than re-exported with a bare
// `export ... from`, which would not bind the name in this module's scope:
// syncInvoiceStatusFromPaymentEntry below calls it. The re-export is for
// engine.ts, which has always taken it from here. PAYMENT_SOURCE_TYPES itself
// is NOT re-exported: every consumer of the array reads the owning module.
import { isPaymentSourceType } from './payment-source-types'

export { isPaymentSourceType }

/**
 * Customer-side payment vouchers only. The DELETE voucher route syncs these in
 * TS; supplier payments and utlägg are reverted inside delete_last_voucher
 * itself (migration 20260920190000), in the same transaction as the delete.
 * Running this module's supplier branch after that RPC would apply the
 * reversal a second time: on a part payment it takes paid_amount from the
 * already-reverted value down to zero and wipes the payment that should stand.
 */
export function isCustomerPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType || !isPaymentSourceType(sourceType)) return false
  return !sourceType.startsWith('supplier_invoice')
}

/**
 * The subledger rows a payment voucher is tied to, read while the voucher still
 * exists. Everything below is addressed by these ids, never by journal_entry_id:
 * supplier_invoice_payments.journal_entry_id, invoice_payments.journal_entry_id
 * and transactions.journal_entry_id are all ON DELETE SET NULL, so once
 * delete_last_voucher has removed the entry, a lookup by entry id finds nothing.
 */
export interface PaymentEntryLinks {
  /** This invoice's payment rows on the entry (one in practice; summed). */
  paymentRows: Array<{ id: string; amount: number; transaction_id: string | null }>
  /** Bank rows whose journal_entry_id pointer names the entry. */
  transactionIds: string[]
}

/**
 * Read the payment rows and bank rows a payment entry is linked to. Returns
 * null for an entry that is not a payment (nothing to sync). Read-only.
 *
 * The DELETE voucher route calls this BEFORE delete_last_voucher and passes the
 * result to syncInvoiceStatusFromPaymentEntry afterwards; storno calls the sync
 * without it, which loads the links itself (the reversed entry still exists).
 * Throws on a read error, so the route refuses the delete instead of deleting
 * with links it could not see.
 */
export async function loadPaymentEntryLinks(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
): Promise<PaymentEntryLinks | null> {
  if (!isPaymentSourceType(entry.source_type) || !entry.source_id) return null

  const isSupplier = entry.source_type.startsWith('supplier_invoice')
  // Scoped to THIS invoice: a batch voucher (match_batch_allocate) carries one
  // payment row per invoice under the same journal_entry_id, and this call only
  // restores the source invoice's status (PR #666 review, SOC 2 CC6.3).
  const { data: paymentRows, error: paymentRowsError } = await supabase
    .from(isSupplier ? 'supplier_invoice_payments' : 'invoice_payments')
    .select('id, amount, transaction_id')
    .eq('journal_entry_id', entry.id)
    .eq(isSupplier ? 'supplier_invoice_id' : 'invoice_id', entry.source_id)
    .eq('company_id', companyId)
  // An unread link is not an absent one: treated as empty, the sync would
  // revert the whole paid_amount and strand the row once the entry is gone.
  if (paymentRowsError) throw paymentRowsError

  const { data: transactions, error: transactionsError } = await supabase
    .from('transactions')
    .select('id')
    .eq('company_id', companyId)
    .eq('journal_entry_id', entry.id)
  if (transactionsError) throw transactionsError

  return {
    paymentRows: (paymentRows ?? []) as PaymentEntryLinks['paymentRows'],
    transactionIds: ((transactions ?? []) as Array<{ id: string }>).map((t) => t.id),
  }
}

/**
 * Revert the business-level paid status on the invoice or supplier invoice
 * that a payment journal entry was attached to. Used by both reverseEntry()
 * (storno) and the DELETE journal entry route: both paths leave the GL in a
 * consistent state but the invoice's status/paid_amount/paid_at would otherwise
 * stay stuck on "paid".
 *
 * `links` must be loaded before the entry is deleted (see loadPaymentEntryLinks);
 * when omitted they are loaded here, which is only correct while the entry
 * still exists (storno).
 *
 * Safe to call with any entry: returns early if source_type is not a payment.
 */
export async function syncInvoiceStatusFromPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>,
  links?: PaymentEntryLinks | null
): Promise<void> {
  if (!isPaymentSourceType(entry.source_type) || !entry.source_id) return

  const entryId = entry.id
  let resolved = links ?? null
  if (!resolved) {
    try {
      resolved = await loadPaymentEntryLinks(supabase, companyId, entry)
    } catch (loadError) {
      // Same contract as an unreadable invoice below: change nothing, so the
      // invoice, payment row and bank line stay mutually consistent.
      log.error('Failed to read payment links for payment reversal: aborting status sync', loadError, {
        companyId,
        journalEntryId: entryId,
      })
      return
    }
  }
  if (!resolved) return
  const paymentRowIds = resolved.paymentRows.map((r) => r.id)
  // null when the entry has no payment row: cash entries book none.
  const reversedAmount = resolved.paymentRows.length > 0
    ? roundOre(resolved.paymentRows.reduce((sum, r) => sum + Number(r.amount), 0))
    : null
  const releaseTransactionIds = [
    ...resolved.transactionIds,
    ...resolved.paymentRows.map((r) => r.transaction_id),
  ]

  if (entry.source_type.startsWith('supplier_invoice')) {
    // Column is `total`, not `total_amount` (supplier_invoices has never had a
    // total_amount column). Selecting the wrong name made PostgREST reject the
    // whole query, so `supplierInvoice` was always null: the restore below was
    // silently skipped while the payment-row delete and the bank-line release
    // still ran. The invoice then stayed 'paid' with a stale paid_amount and
    // nothing behind it, so the AP ledger (leverantörsreskontra) showed money
    // as paid that was never paid.
    const { data: supplierInvoice, error: supplierInvoiceError } = await supabase
      .from('supplier_invoices')
      .select('paid_amount, total, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    // PGRST116 = no row: the invoice itself is gone, so there is nothing to
    // restore and the cleanup below is still the right thing to do. Any OTHER
    // error means we could not read the state we are about to overwrite.
    // Deleting the payment row and releasing the bank line at that point would
    // destroy the only evidence of the payment while the invoice stays 'paid':
    // exactly the wrong-AP-ledger outcome above. Abort instead, at ERROR level
    // so the failure is observable: the storno is already committed and both
    // callers (reverseEntry, the DELETE voucher route) treat this sync as
    // best-effort, so bailing out leaves invoice + payment row + bank line
    // mutually consistent and the operation safely re-runnable.
    if (supplierInvoiceError && supplierInvoiceError.code !== 'PGRST116') {
      log.error(
        'Failed to read supplier invoice for payment reversal: aborting status sync',
        supplierInvoiceError,
        { companyId, journalEntryId: entryId, supplierInvoiceId: entry.source_id }
      )
      return
    }

    if (supplierInvoice) {
      // Same fallback semantics as the customer branch below: a cash payment
      // (supplier_invoice_cash_payment) books no payment row and is only ever
      // a FULL payment, so reverting the whole paid_amount is correct. The
      // old `&& payment` guard skipped the restore entirely for cash
      // reversals, leaving the supplier invoice deadlocked on 'paid'.
      const paymentAmount = reversedAmount ?? supplierInvoice.paid_amount
      const newPaidAmount = roundOre(supplierInvoice.paid_amount - paymentAmount)
      const newRemaining = roundOre(supplierInvoice.total - Math.max(0, newPaidAmount))
      let newStatus: string
      if (newPaidAmount > 0) {
        newStatus = 'partially_paid'
      } else if (supplierInvoice.due_date && new Date(supplierInvoice.due_date) < new Date()) {
        newStatus = 'overdue'
      } else {
        newStatus = 'approved'
      }

      const { error: supplierUpdateError } = await supabase
        .from('supplier_invoices')
        .update({
          status: newStatus,
          paid_amount: Math.max(0, newPaidAmount),
          remaining_amount: newRemaining,
          paid_at: null,
          payment_journal_entry_id: null,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
      // The row delete and bank release below are the rest of this restore:
      // without the restore they leave the invoice paid with nothing behind it.
      if (supplierUpdateError) {
        log.error('Failed to restore supplier invoice for payment reversal: aborting status sync', supplierUpdateError, {
          companyId,
          journalEntryId: entryId,
          supplierInvoiceId: entry.source_id,
        })
        return
      }
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // re-match of the same bank line doesn't double-count or trip the unique
    // index on supplier_invoice_payments. By id: after delete_last_voucher the
    // row's journal_entry_id is already NULL (ON DELETE SET NULL), and deleting
    // by entry id left it behind in the invoice's payment history.
    await deletePaymentRows(supabase, companyId, 'supplier_invoice_payments', paymentRowIds, entryId)

    await releaseLinkedTransactions(supabase, companyId, entryId, releaseTransactionIds, 'supplier_invoice_id')
  } else {
    const { data: customerInvoice, error: customerInvoiceError } = await supabase
      .from('invoices')
      .select('paid_amount, total, due_date, deduction_total, deduction_reclaimed_total')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    // Same contract as the supplier branch: PGRST116 (invoice gone) still
    // cleans up; any other read error changes nothing.
    if (customerInvoiceError && customerInvoiceError.code !== 'PGRST116') {
      log.error('Failed to read invoice for payment reversal: aborting status sync', customerInvoiceError, {
        companyId,
        journalEntryId: entryId,
        invoiceId: entry.source_id,
      })
      return
    }

    if (customerInvoice) {
      // For a partial reversal we take the exact amount from the payment row.
      // The fallback (full paid_amount) only applies when no payment row exists:
      // true for invoice_cash_payment, which is only ever booked on a FULL
      // payment, so reverting the whole paid_amount is correct there. Guarding
      // this keeps a future partial-cash path from over-reverting.
      const paymentAmount = reversedAmount ?? customerInvoice.paid_amount
      const newPaidAmount = roundOre(customerInvoice.paid_amount - paymentAmount)
      const safePaidAmount = Math.max(0, newPaidAmount)
      // The supplier branch already resets remaining_amount; the customer branch
      // never did, leaving it stale (= total) after a reversal so the invoice
      // showed fully unpaid yet stuck on 'paid'. Recompute from total. (The
      // .in('status', …) guard below can leave status/remaining un-updated if
      // the invoice isn't paid/partially_paid: only reachable on a non-storno
      // path; the payment-row delete + tx release still run, freeing the line.)
      //
      // remaining_amount is the CUSTOMER share: net of the ROT/RUT deduction,
      // exactly as build-invoice-write stores it at creation (total -
      // deduction_total) and as the invoices_remaining_amount_guard trigger
      // derives it. Recomputing gross here inflated remaining on ROT/RUT
      // invoices after a storno, which made them permanently un-settleable
      // once mark-paid started comparing the net customer settlement against
      // remaining (a net payment can never reach a gross remaining, and the
      // cash-partial block rejects the "partial"). The share comes from the
      // one shared definition (lib/invoices/customer-share.ts); the
      // Math.max(0, ...) mirrors the guard's GREATEST(0, ...) because this
      // value is persisted into the column.
      // A refused deduction that a rot_rut_reclaim voucher moved back onto
      // the customer is the customer's again: without this term a storno of
      // any payment on a reopened invoice wrote a remaining short by the
      // reclaimed share and no path could settle it (skeptic #2397 R1).
      const { deduction_total: deductionTotal = 0, deduction_reclaimed_total: reclaimedTotal = 0 } =
        customerInvoice as { deduction_total?: number | null; deduction_reclaimed_total?: number | null }
      const newRemaining = Math.max(
        0,
        invoiceCustomerOutstanding(
          {
            total: customerInvoice.total,
            deduction_total: deductionTotal ?? 0,
            deduction_reclaimed_total: reclaimedTotal ?? 0,
          },
          safePaidAmount,
        ),
      )
      const revertStatus = newPaidAmount > 0
        ? 'partially_paid'
        : customerInvoice.due_date && new Date(customerInvoice.due_date) < new Date()
          ? 'overdue'
          : 'sent'

      const { error: customerUpdateError } = await supabase
        .from('invoices')
        .update({
          status: revertStatus,
          paid_at: null,
          paid_amount: safePaidAmount,
          remaining_amount: newRemaining,
        })
        .eq('id', entry.source_id)
        .eq('company_id', companyId)
        .in('status', ['paid', 'partially_paid'])
      if (customerUpdateError) {
        log.error('Failed to restore invoice for payment reversal: aborting status sync', customerUpdateError, {
          companyId,
          journalEntryId: entryId,
          invoiceId: entry.source_id,
        })
        return
      }
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // re-match of the same bank line doesn't trip the (transaction_id,
    // invoice_id) / (journal_entry_id, invoice_id) unique indexes on
    // invoice_payments. By id, for the same reason as the supplier branch.
    await deletePaymentRows(supabase, companyId, 'invoice_payments', paymentRowIds, entryId)

    await releaseLinkedTransactions(supabase, companyId, entryId, releaseTransactionIds, 'invoice_id')
  }
}

async function deletePaymentRows(
  supabase: SupabaseClient,
  companyId: string,
  table: 'invoice_payments' | 'supplier_invoice_payments',
  paymentRowIds: string[],
  entryId: string,
): Promise<void> {
  if (paymentRowIds.length === 0) return
  const { error } = await supabase
    .from(table)
    .delete()
    .eq('company_id', companyId)
    .in('id', paymentRowIds)
  if (error) {
    log.error('Failed to delete payment rows of reversed payment voucher', error, {
      companyId,
      journalEntryId: entryId,
      table,
      paymentRowIds,
    })
  }
}

/**
 * Detach any bank transactions still pointing at a reversed payment voucher so
 * the bank line returns to the inbox and becomes re-matchable. Without this, a
 * standalone storno (the reverse route / MCP reverse tool / delete-last-voucher)
 * leaves transactions.journal_entry_id pointing at a reversed JE: the match
 * POST refuses (invoice no longer matchable once we also fix its status) and the
 * line can't be re-booked or deleted. The match-invoice route already clears the
 * tx when IT stornos a conflicting auto-categorization JE; this covers every
 * other reversal path. After delete_last_voucher the pointer is already NULL
 * (ON DELETE SET NULL) but invoice_id/category/is_business are not, which kept
 * the line out of the inbox.
 *
 * Releases by id: the rows whose pointer named the entry (covers the link even
 * when the payment row was missing) and the payment rows' transaction ids
 * (covers a partial match that cleared journal_entry_id but left
 * invoice_id/category set), both loaded by loadPaymentEntryLinks. Only the
 * link/categorization columns are reset; the transaction row is preserved.
 */
async function releaseLinkedTransactions(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
  transactionIds: Array<string | null>,
  invoiceColumn: 'invoice_id' | 'supplier_invoice_id',
): Promise<void> {
  const txIds = [...new Set(transactionIds.filter((id): id is string => !!id))]
  if (txIds.length === 0) return

  const { data: released, error } = await supabase
    .from('transactions')
    .update({
      journal_entry_id: null,
      [invoiceColumn]: null,
      is_business: null,
      category: null,
    })
    .eq('company_id', companyId)
    .in('id', txIds)
    .select('id')
  if (error) {
    // Best-effort like the rest of the sync: the storno itself already
    // committed, but a failed release leaves the bank line stuck on a
    // reversed JE, so it must be observable.
    log.error('Failed to release transactions of reversed payment voucher', error, {
      companyId,
      journalEntryId: entryId,
      transactionIds: txIds,
    })
  } else if (released && released.length > 0) {
    // transactions has no write_audit_log trigger, so the clearing of the
    // link/categorization columns is logged here for incident reconstruction.
    log.info('Released bank transactions from reversed payment voucher', {
      companyId,
      journalEntryId: entryId,
      invoiceColumn,
      transactionIds: released.map((r) => (r as { id: string }).id),
    })
  }
}
