/**
 * Supplier-invoice actions outside the booking verbs: delete an unbooked
 * invoice, undo a credit ("Ångra kreditering"), and the "inlagd i banken"
 * mark. One implementation behind the dashboard routes
 * (/api/supplier-invoices/[id] DELETE, /uncredit, /bank-entered) and the v1
 * operations and MCP tools (lib/operations/supplier-invoice-actions.ts), so
 * every door applies the same rules:
 *
 * Delete:
 *   - never a credit note: deleting only the row would orphan its posted
 *     reversal verifikat; the original's "Ångra kreditering" is the path;
 *   - only unsettled, unpaid states (registered, approved, overdue);
 *   - never an invoice with a registration verifikat, a payment row, an
 *     accrual schedule or a payment-batch row (each lookup fails CLOSED:
 *     a read error blocks the delete instead of reading as "none");
 *   - a posted verifikat is never deleted here: a booked invoice is withdrawn
 *     with a credit note (BFL 5 kap 5 §).
 *
 * Uncredit:
 *   - the credit note's posted verifikat is cancelled with a storno
 *     (reverseEntry), never edited or deleted; an already reversed or never
 *     posted verifikat is fine and the row cleanup continues;
 *   - the credit note row is kept and marked 'reversed' (BFL 7 kap retention,
 *     unbroken ankomstnummer series, sambandskravet);
 *   - the original's status and remaining amount are recomputed from its
 *     payments; an invoice that is not credited is an idempotent no-op.
 *
 * Bank-entered:
 *   - a mark, not a payment: it books nothing and moves no amount or status;
 *   - setting it needs an unpaid, payable invoice (compare-and-set on the
 *     eligibility read), clearing it is allowed in any status.
 *
 * A dry run reads and checks; it writes nothing (it is also the MCP staging
 * preview).
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { SupplierInvoice, SupplierInvoicePayment } from '@/types'
import { roundOre } from '@/lib/money'
import { eventBus } from '@/lib/events'
import { reverseEntry } from '@/lib/bookkeeping/engine'
import {
  CannotReverseNonPostedError,
  EntryAlreadyReversedError,
  isBookkeepingError,
} from '@/lib/bookkeeping/errors'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import {
  BANK_ENTERED_SUPPLIER_INVOICE_STATUSES,
  canMarkSupplierInvoiceBankEntered,
} from '@/lib/supplier-invoices/lifecycle'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

const NOT_FOUND: Failure = { ok: false, code: 'SI_NOT_FOUND' }

function failed(error: unknown): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

/** Lifecycle labels an unbooked, unpaid invoice can carry (the overdue cron moves registered/approved to overdue). */
const DELETABLE_STATUSES = ['registered', 'approved', 'overdue'] as const

export interface DeleteSupplierInvoiceResult {
  supplier_invoice_id: string
  deleted: true
}

export async function deleteSupplierInvoice(
  ctx: OperationContext,
  supplierInvoiceId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<DeleteSupplierInvoiceResult>> {
  const { supabase, companyId, log } = ctx

  const { data: existing } = await supabase
    .from('supplier_invoices')
    .select('status, registration_journal_entry_id, is_credit_note, arrival_number, supplier_invoice_number, total, currency')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .single()
  if (!existing) return NOT_FOUND

  if (existing.is_credit_note) return { ok: false, code: 'SI_DELETE_CREDIT_NOTE' }

  if (!(DELETABLE_STATUSES as readonly string[]).includes(existing.status as string)) {
    return { ok: false, code: 'SI_DELETE_INVALID_STATUS', details: { currentStatus: existing.status } }
  }

  if (existing.registration_journal_entry_id) {
    return { ok: false, code: 'SI_DELETE_HAS_BOOKING', details: { reason: 'registration_journal_entry' } }
  }

  const { data: linkedPayment, error: paymentLookupError } = await supabase
    .from('supplier_invoice_payments')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .limit(1)
    .maybeSingle()
  if (paymentLookupError) return failed(paymentLookupError)
  if (linkedPayment) {
    return { ok: false, code: 'SI_DELETE_HAS_BOOKING', details: { reason: 'payments', paymentId: linkedPayment.id } }
  }

  const { data: linkedSchedule, error: scheduleLookupError } = await supabase
    .from('accrual_schedules')
    .select('id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .limit(1)
    .maybeSingle()
  if (scheduleLookupError) return failed(scheduleLookupError)
  if (linkedSchedule) {
    return {
      ok: false,
      code: 'SI_DELETE_HAS_BOOKING',
      details: { reason: 'accrual_schedule', scheduleId: linkedSchedule.id },
    }
  }

  // supplier_payment_batch_items.supplier_invoice_id is ON DELETE RESTRICT:
  // the invoice DELETE would fail after the items were already deleted.
  const { data: linkedBatchItem, error: batchLookupError } = await supabase
    .from('supplier_payment_batch_items')
    .select('id, batch_id')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .limit(1)
    .maybeSingle()
  if (batchLookupError) return failed(batchLookupError)
  if (linkedBatchItem) {
    return { ok: false, code: 'SI_DELETE_IN_PAYMENT_BATCH', details: { batchId: linkedBatchItem.batch_id } }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: supplierInvoiceId,
        arrival_number: existing.arrival_number ?? null,
        supplier_invoice_number: existing.supplier_invoice_number ?? null,
        status: existing.status,
        total: existing.total ?? null,
        currency: existing.currency ?? null,
        will: 'delete the unbooked supplier invoice and its rows; no verifikat exists, so nothing in the books changes',
      },
    }
  }

  // Items first (the invoice row owns them), then the invoice.
  await supabase.from('supplier_invoice_items').delete().eq('supplier_invoice_id', supplierInvoiceId)

  const { error } = await supabase
    .from('supplier_invoices')
    .delete()
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
  if (error) {
    log.error('supplier invoice delete failed', error as unknown as Error, { supplierInvoiceId })
    return failed(error)
  }

  return { ok: true, data: { supplier_invoice_id: supplierInvoiceId, deleted: true } }
}

// ---------------------------------------------------------------------------
// Uncredit ("Ångra kreditering")
// ---------------------------------------------------------------------------

type OriginalWithPayments = SupplierInvoice & { payments?: SupplierInvoicePayment[] | null }

/**
 * The status and remaining amount the original returns to once its credit
 * is undone, from what is actually paid. Pure.
 */
export function restoredAfterUncredit(
  original: Pick<SupplierInvoice, 'total' | 'due_date' | 'registration_journal_entry_id'>,
  payments: ReadonlyArray<Pick<SupplierInvoicePayment, 'amount'>>,
  now: Date = new Date(),
): { status: SupplierInvoice['status']; remaining_amount: number } {
  const paidSum = roundOre(payments.reduce((sum, p) => sum + (p.amount || 0), 0))
  const total = original.total || 0
  const remaining = roundOre(total - paidSum)

  let status: SupplierInvoice['status']
  if (paidSum >= total && total > 0) {
    status = 'paid'
  } else if (paidSum > 0) {
    status = 'partially_paid'
  } else if (original.due_date && new Date(original.due_date) < now) {
    status = 'overdue'
  } else if (original.registration_journal_entry_id) {
    // A posted verifikat exists: safe to restore to 'approved'.
    status = 'approved'
  } else {
    // No registration verifikat (kontantmetoden, or an inconsistent row):
    // 'approved' without a verifikat would break sambandskravet (BFL 4 kap
    // 2 §), so fall back to 'registered'.
    status = 'registered'
  }
  return { status, remaining_amount: remaining }
}

export interface UncreditSupplierInvoiceResult {
  /** The original invoice row after the undo (unchanged when changed=false). */
  supplier_invoice: SupplierInvoice
  /** The storno that cancelled the credit note's verifikat, when one was posted. */
  reversal_entry_id: string | null
  /** False when the invoice was not credited (idempotent no-op). */
  changed: boolean
  /** The credit note row marked 'reversed', when one was found. */
  reversed_credit_note_id: string | null
}

export async function uncreditSupplierInvoice(
  ctx: OperationContext,
  supplierInvoiceId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<UncreditSupplierInvoiceResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: row, error: fetchError } = await supabase
    .from('supplier_invoices')
    .select('*, payments:supplier_invoice_payments(*)')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .single()
  if (fetchError || !row) return NOT_FOUND
  const original = row as OriginalWithPayments

  // Idempotent no-op: an already-uncredited or never-credited invoice just
  // answers the row, so a client retry can call this blindly.
  if (original.status !== 'credited') {
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          supplier_invoice_id: original.id,
          status: original.status,
          changed: false,
          will: 'change nothing: the invoice is not credited',
        },
      }
    }
    return {
      ok: true,
      data: { supplier_invoice: original, reversal_entry_id: null, changed: false, reversed_credit_note_id: null },
    }
  }

  // Re-crediting after an earlier uncredit leaves a reversed credit row
  // behind, so only the live (non-reversed) one counts.
  const { data: creditNote } = await supabase
    .from('supplier_invoices')
    .select('id, registration_journal_entry_id')
    .eq('company_id', companyId)
    .eq('credited_invoice_id', supplierInvoiceId)
    .eq('is_credit_note', true)
    .neq('status', 'reversed')
    .maybeSingle()

  const payments = (original.payments as SupplierInvoicePayment[] | null) ?? []
  const restored = restoredAfterUncredit(original, payments)

  if (options.dryRun) {
    let postsStorno = false
    let creditEntry: { entry_date: string; voucher: string | null } | null = null
    if (creditNote?.registration_journal_entry_id) {
      const { data: entry } = await supabase
        .from('journal_entries')
        .select('status, entry_date, voucher_series, voucher_number')
        .eq('id', creditNote.registration_journal_entry_id)
        .eq('company_id', companyId)
        .maybeSingle()
      if (entry?.status === 'posted') {
        // The storno is dated on the credit verifikat's own date; a locked
        // or closed period refuses it at commit, so refuse the stage too.
        const verdict = await checkPeriodLock(supabase, companyId, entry.entry_date as string)
        if (verdict.locked) {
          return {
            ok: false,
            code: 'PERIOD_LOCKED',
            details: {
              reason: verdict.reason,
              ...(verdict.fiscal_period_id ? { fiscal_period_id: verdict.fiscal_period_id } : {}),
              entry_date: entry.entry_date,
            },
          }
        }
        postsStorno = true
        creditEntry = {
          entry_date: entry.entry_date as string,
          voucher: entry.voucher_number ? `${entry.voucher_series ?? ''}${entry.voucher_number}` : null,
        }
      }
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: original.id,
        arrival_number: original.arrival_number ?? null,
        supplier_invoice_number: original.supplier_invoice_number ?? null,
        changed: true,
        credit_note_id: creditNote?.id ?? null,
        credit_journal_entry_id: creditNote?.registration_journal_entry_id ?? null,
        credit_voucher: creditEntry?.voucher ?? null,
        posts_storno: postsStorno,
        storno_date: creditEntry?.entry_date ?? null,
        restored_status: restored.status,
        remaining_amount: restored.remaining_amount,
        will: postsStorno
          ? 'post a storno cancelling the credit note\'s verifikat, mark the credit note reversed (kept for the archive) and restore the invoice'
          : 'mark the credit note reversed (kept for the archive) and restore the invoice; no verifikat to cancel',
      },
    }
  }

  let reversalEntryId: string | null = null
  if (creditNote?.registration_journal_entry_id) {
    try {
      const reversal = await reverseEntry(supabase, companyId, userId, creditNote.registration_journal_entry_id)
      reversalEntryId = reversal.id
    } catch (err) {
      // Already reversed (by hand or a concurrent uncredit): continue with
      // the row cleanup.
      if (!(err instanceof CannotReverseNonPostedError || err instanceof EntryAlreadyReversedError)) {
        if (isBookkeepingError(err)) return { ok: false, code: 'SI_UNCREDIT_FAILED', error: err }
        // Period lock and similar trigger errors: the Swedish sentence says why.
        return {
          ok: false,
          code: 'SI_UNCREDIT_FAILED',
          messageSv: getErrorMessage(err, { context: 'supplier_invoice' }),
        }
      }
    }
  }

  if (creditNote) {
    // Soft-delete: the credit row and its items are kept (BFL 7 kap, the
    // ankomstnummer series, sambandskravet). The partial unique index
    // excludes status='reversed', so the invoice can be credited again.
    const { error: reverseMarkError } = await supabase
      .from('supplier_invoices')
      .update({ status: 'reversed', reversed_at: new Date().toISOString() })
      .eq('id', creditNote.id)
      .eq('company_id', companyId)
    if (reverseMarkError) {
      log.error('uncredit: marking the credit note reversed failed', reverseMarkError as unknown as Error, {
        supplierInvoiceId,
      })
      return {
        ok: false,
        code: 'SI_UNCREDIT_FAILED',
        messageSv: getErrorMessage(reverseMarkError, { context: 'supplier_invoice' }),
        details: { reversal_entry_id: reversalEntryId },
      }
    }
  }

  const { data: updated, error: updateError } = await supabase
    .from('supplier_invoices')
    .update({ status: restored.status, remaining_amount: restored.remaining_amount })
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .select()
    .single()
  if (updateError || !updated) {
    log.error('uncredit: restoring the original failed', updateError as unknown as Error, { supplierInvoiceId })
    return {
      ok: false,
      code: 'SI_UNCREDIT_FAILED',
      ...(updateError ? { messageSv: getErrorMessage(updateError, { context: 'supplier_invoice' }) } : {}),
      details: { reversal_entry_id: reversalEntryId },
    }
  }

  try {
    await eventBus.emit({
      type: 'supplier_invoice.uncredited',
      payload: {
        supplierInvoice: updated as SupplierInvoice,
        reversedCreditNoteId: creditNote?.id ?? '',
        reversalEntryId,
        userId,
        companyId,
      },
    })
  } catch {
    // Non-blocking
  }

  return {
    ok: true,
    data: {
      supplier_invoice: updated as SupplierInvoice,
      reversal_entry_id: reversalEntryId,
      changed: true,
      reversed_credit_note_id: creditNote?.id ?? null,
    },
  }
}

// ---------------------------------------------------------------------------
// "Inlagd i banken" mark (#2220)
// ---------------------------------------------------------------------------

export interface BankEnteredResult {
  id: string
  bank_entered_at: string | null
}

export async function setSupplierInvoiceBankEntered(
  ctx: OperationContext,
  supplierInvoiceId: string,
  entered: boolean,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<BankEnteredResult>> {
  const { supabase, companyId, log } = ctx

  const { data: invoice } = await supabase
    .from('supplier_invoices')
    .select('id, status, is_credit_note, bank_entered_at')
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (!invoice) return NOT_FOUND

  if (entered && !canMarkSupplierInvoiceBankEntered(invoice)) {
    return { ok: false, code: 'SI_BANK_ENTERED_NOT_PAYABLE', details: { currentStatus: invoice.status } }
  }

  // Marking an already-marked invoice keeps the first timestamp (that is
  // when it went into the bank). Clearing is allowed in any status: a stale
  // mark on a settled row is never worth refusing.
  const current = (invoice.bank_entered_at as string | null) ?? null

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        supplier_invoice_id: invoice.id,
        status: invoice.status,
        entered,
        bank_entered_at_before: current,
        changed: entered ? current === null : current !== null,
      },
    }
  }

  const bankEnteredAt = entered ? (current ?? new Date().toISOString()) : null

  let update = supabase
    .from('supplier_invoices')
    .update({ bank_entered_at: bankEnteredAt })
    .eq('id', supplierInvoiceId)
    .eq('company_id', companyId)
  if (entered) {
    // Compare-and-set on the eligibility just read: a payment landing in
    // between becomes zero matched rows, not a mark on a paid invoice.
    update = update.in('status', [...BANK_ENTERED_SUPPLIER_INVOICE_STATUSES]).eq('is_credit_note', false)
  }
  const { data, error } = await update.select('id, bank_entered_at').maybeSingle()
  if (error) {
    log.error('supplier_invoices bank_entered_at update failed', error as unknown as Error)
    return failed(error)
  }
  if (!data) return { ok: false, code: 'SI_BANK_ENTERED_NOT_PAYABLE', details: { reason: 'race' } }

  return { ok: true, data: data as BankEnteredResult }
}
