import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { JournalEntry } from '@/types'

const log = createLogger('payment-sync')

export const PAYMENT_SOURCE_TYPES = [
  'invoice_paid',
  'invoice_cash_payment',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
] as const

export function isPaymentSourceType(sourceType: string | null | undefined): boolean {
  if (!sourceType) return false
  return (PAYMENT_SOURCE_TYPES as readonly string[]).includes(sourceType)
}

/**
 * Revert the business-level paid status on the invoice or supplier invoice
 * that a payment journal entry was attached to. Used by both reverseEntry()
 * (storno) and the DELETE journal entry route: both paths leave the GL in a
 * consistent state but the invoice's status/paid_amount/paid_at would otherwise
 * stay stuck on "paid".
 *
 * Safe to call with any entry: returns early if source_type is not a payment.
 */
export async function syncInvoiceStatusFromPaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  entry: Pick<JournalEntry, 'id' | 'source_type' | 'source_id'>
): Promise<void> {
  if (!isPaymentSourceType(entry.source_type) || !entry.source_id) return

  const entryId = entry.id

  if (entry.source_type.startsWith('supplier_invoice')) {
    // Scope to THIS invoice's payment row: a batch voucher (match_batch_allocate)
    // carries one payment row per invoice under the same journal_entry_id, so an
    // unfiltered .single() errors out on multi-row and silently yields null.
    const { data: payment } = await supabase
      .from('supplier_invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .eq('supplier_invoice_id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    const { data: supplierInvoice } = await supabase
      .from('supplier_invoices')
      .select('paid_amount, total_amount, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (supplierInvoice) {
      // Same fallback semantics as the customer branch below: a cash payment
      // (supplier_invoice_cash_payment) books no payment row and is only ever
      // a FULL payment, so reverting the whole paid_amount is correct. The
      // old `&& payment` guard skipped the restore entirely for cash
      // reversals, leaving the supplier invoice deadlocked on 'paid'.
      const paymentAmount = payment?.amount ?? supplierInvoice.paid_amount
      const newPaidAmount = roundOre(supplierInvoice.paid_amount - paymentAmount)
      const newRemaining = roundOre(supplierInvoice.total_amount - Math.max(0, newPaidAmount))
      let newStatus: string
      if (newPaidAmount > 0) {
        newStatus = 'partially_paid'
      } else if (supplierInvoice.due_date && new Date(supplierInvoice.due_date) < new Date()) {
        newStatus = 'overdue'
      } else {
        newStatus = 'approved'
      }

      await supabase
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
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // re-match of the same bank line doesn't double-count or trip the unique
    // index on supplier_invoice_payments. Scoped to the source invoice: a
    // batch voucher carries sibling rows for other invoices whose status this
    // call does not restore, so deleting them here would desync paid_amount
    // from the payment rows (PR #666 review, SOC 2 CC6.3). Capture the linked
    // transaction id first so the bank line can be released back to the inbox.
    const { data: spRows } = await supabase
      .from('supplier_invoice_payments')
      .select('transaction_id')
      .eq('journal_entry_id', entryId)
      .eq('supplier_invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await supabase
      .from('supplier_invoice_payments')
      .delete()
      .eq('journal_entry_id', entryId)
      .eq('supplier_invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await releaseLinkedTransactions(
      supabase,
      companyId,
      entryId,
      (spRows ?? []).map((r) => (r as { transaction_id: string | null }).transaction_id),
      'supplier_invoice_id',
    )
  } else {
    // Scoped like the supplier branch: filter by invoice_id + company_id so a
    // batch voucher's sibling payment rows don't break the .single().
    const { data: payment } = await supabase
      .from('invoice_payments')
      .select('amount')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    const { data: customerInvoice } = await supabase
      .from('invoices')
      .select('paid_amount, total, due_date')
      .eq('id', entry.source_id)
      .eq('company_id', companyId)
      .single()

    if (customerInvoice) {
      // For a partial reversal we take the exact amount from the payment row.
      // The fallback (full paid_amount) only applies when no payment row exists:
      // true for invoice_cash_payment, which is only ever booked on a FULL
      // payment, so reverting the whole paid_amount is correct there. Guarding
      // this keeps a future partial-cash path from over-reverting.
      const paymentAmount = payment?.amount ?? customerInvoice.paid_amount
      const newPaidAmount = roundOre(customerInvoice.paid_amount - paymentAmount)
      const safePaidAmount = Math.max(0, newPaidAmount)
      // The supplier branch already resets remaining_amount; the customer branch
      // never did, leaving it stale (= total) after a reversal so the invoice
      // showed fully unpaid yet stuck on 'paid'. Recompute from total. (The
      // .in('status', …) guard below can leave status/remaining un-updated if
      // the invoice isn't paid/partially_paid: only reachable on a non-storno
      // path; the payment-row delete + tx release still run, freeing the line.)
      const newRemaining = roundOre(customerInvoice.total - safePaidAmount)
      const revertStatus = newPaidAmount > 0
        ? 'partially_paid'
        : customerInvoice.due_date && new Date(customerInvoice.due_date) < new Date()
          ? 'overdue'
          : 'sent'

      await supabase
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
    }

    // Remove THIS invoice's payment row tied to the reversed voucher so a
    // re-match of the same bank line doesn't trip the (transaction_id,
    // invoice_id) / (journal_entry_id, invoice_id) unique indexes on
    // invoice_payments. Scoped to the source invoice: see the supplier
    // branch comment for the batch-voucher rationale.
    const { data: ipRows } = await supabase
      .from('invoice_payments')
      .select('transaction_id')
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await supabase
      .from('invoice_payments')
      .delete()
      .eq('journal_entry_id', entryId)
      .eq('invoice_id', entry.source_id)
      .eq('company_id', companyId)

    await releaseLinkedTransactions(
      supabase,
      companyId,
      entryId,
      (ipRows ?? []).map((r) => (r as { transaction_id: string | null }).transaction_id),
      'invoice_id',
    )
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
 * other reversal path.
 *
 * Clears by journal_entry_id (covers the link even when the payment row was
 * missing) and by the captured payment-row transaction ids (covers a partial
 * match that cleared journal_entry_id but left invoice_id/category set). Only
 * the link/categorization columns are reset; the transaction row is preserved.
 */
async function releaseLinkedTransactions(
  supabase: SupabaseClient,
  companyId: string,
  entryId: string,
  paymentTransactionIds: Array<string | null>,
  invoiceColumn: 'invoice_id' | 'supplier_invoice_id',
): Promise<void> {
  const resetFields = {
    journal_entry_id: null,
    [invoiceColumn]: null,
    is_business: null,
    category: null,
  }

  const { data: releasedByEntry, error: byEntryError } = await supabase
    .from('transactions')
    .update(resetFields)
    .eq('company_id', companyId)
    .eq('journal_entry_id', entryId)
    .select('id')
  if (byEntryError) {
    // Best-effort like the rest of the sync: the storno itself already
    // committed, but a failed release leaves the bank line stuck on a
    // reversed JE, so it must be observable.
    log.error('Failed to release transactions by journal_entry_id', byEntryError, {
      companyId,
      journalEntryId: entryId,
    })
  } else if (releasedByEntry && releasedByEntry.length > 0) {
    // transactions has no write_audit_log trigger, so the clearing of the
    // link/categorization columns is logged here for incident reconstruction.
    log.info('Released bank transactions from reversed payment voucher', {
      companyId,
      journalEntryId: entryId,
      invoiceColumn,
      transactionIds: releasedByEntry.map((r) => (r as { id: string }).id),
    })
  }

  const txIds = paymentTransactionIds.filter((id): id is string => !!id)
  if (txIds.length > 0) {
    const { data: releasedById, error: byIdError } = await supabase
      .from('transactions')
      .update(resetFields)
      .eq('company_id', companyId)
      .in('id', txIds)
      .select('id')
    if (byIdError) {
      log.error('Failed to release transactions by payment transaction ids', byIdError, {
        companyId,
        journalEntryId: entryId,
        transactionIds: txIds,
      })
    } else if (releasedById && releasedById.length > 0) {
      log.info('Released payment-linked bank transactions from reversed voucher', {
        companyId,
        journalEntryId: entryId,
        invoiceColumn,
        transactionIds: releasedById.map((r) => (r as { id: string }).id),
      })
    }
  }
}
