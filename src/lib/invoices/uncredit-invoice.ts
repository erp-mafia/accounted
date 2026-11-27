/**
 * "Ångra kreditering" of a customer invoice: undo a credit whose kreditfaktura
 * never reached the buyer. The supplier twin is uncreditSupplierInvoice
 * (lib/supplier-invoices/manage.ts); this one serves the dashboard route
 * POST /api/invoices/[id]/uncredit.
 *
 * Only while the credit note has not been given to the customer. A credit
 * note is an ändringsfaktura, a document equated with a faktura (ML 2023:200
 * 17 kap 22 §); the buyer who has received one reverses its deduction of
 * ingående skatt on it (7 kap 48 §). Once delivered it is the buyer's
 * document too, so the seller cannot take it back alone: the claim comes back
 * only with a new invoice, and a delivered credit note is answered with the
 * offer of a copy of the original. One the buyer never got reduced no price:
 * the seller's minskning of utgående skatt rests on a price reduction and the
 * handling of 17 kap 22 § that documents it (7 kap 43, 46 §§), so its
 * verifikat is cancelled with a storno, the rättelse BFL 5 kap 5 § allows
 * for a posted verifikat.
 *
 * Whether it reached the buyer (creditNoteDelivery):
 *   - delivered: an email the app sent or is sending, whatever the provider
 *     reported later (a bounce can come from a later hop while a recipient
 *     got it), or a credit note forwarded to the collection provider of the
 *     original's case: refused, the copy is the way;
 *   - marked sent ("Markera som skickad", or the copy imported from the
 *     previous system): the person attests that it never reached the
 *     customer;
 *   - nothing recorded (issued without a delivery, or an email that failed):
 *     allowed.
 *   Peppol and the digital mailboxes never carry a credit note (both sends
 *   refuse one: peppol-send-service.ts, invoiceMailboxBlock), so only
 *   invoice_deliveries can show one.
 *
 * What it does:
 *   - the credit's standing verifikat (the credit note's own, or the live
 *     correction of it) is cancelled with a storno through the posting port,
 *     dated on that verifikat's date, so its moms returns to the period it
 *     left; one stornoed by hand already, or never posted, needs none;
 *   - the credit note is kept, with its number and archived PDF (BFL 7 kap;
 *     ML 17 kap 24 § p. 2: its löpnummer is never used again), as
 *     'cancelled' with credit_undone_at: shown as Ångrad, out of the
 *     reskontra and the credit cap, never reopened as a draft;
 *   - the original's status and remaining amount come back from what is
 *     paid on it (overdue is derived on every screen, never stored);
 *   - invoice.uncredited records who undid it, the storno and on what the
 *     person relied that the customer never got the credit note.
 *
 * Refused before anything is written, besides a delivered credit note: a
 * refund recorded on the credit note (its verifikat is stornoed first, which
 * gives the credit back), a credit that ended more than its own verifikat
 * (the original's periodiseringar, a kundförlust decision), and an original
 * whose credit is not one issued credit note. An invoice that is not credited
 * answers changed=false. A dry run reads and checks, and writes nothing.
 */
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import type { Invoice } from '@/types'
import { eventBus } from '@/lib/events'
import { postingPort } from '@/lib/posting/port'
import { voucherStornoBusinessEvent } from '@/lib/bookkeeping/ledger-business-events'
import { CannotReverseNonPostedError, EntryAlreadyReversedError } from '@/lib/bookkeeping/errors'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { invoiceCustomerOutstanding } from '@/lib/bookkeeping/customer-share'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { liveEntryOf } from '@/lib/core/bookkeeping/correction-chain'
import { checkPeriodLock } from '@/lib/api/v1/check-period-lock'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { linkBasisColumns } from '@/lib/links/stamp'
import { isActiveCreditNote } from '@/lib/transactions/invoice-document-refusal'
import { REFUNDABLE_CREDIT_NOTE_STATUSES } from './credit-note-refund-plan'

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function failed(error: unknown, details?: Record<string, unknown>): Failure {
  return { ok: false, code: 'UNKNOWN_ERROR', error, ...(details ? { details } : {}) }
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** What reached the buyer of a credit note, as far as the app knows. */
export type CreditNoteDelivery = 'delivered' | 'marked_sent' | 'none'

/** A row of the credit note's delivery history (list_invoice_delivery_summaries). */
export interface CreditNoteDeliveryRow {
  channel: string
  status: string
}

/**
 * Whether the credit note reached the buyer, from its delivery history and
 * whether it was forwarded to a collection provider. Pure.
 *
 * Only a send that failed is no delivery: an email the app sent counts as
 * delivered whatever the provider reported later, and one still on its way
 * may arrive. A manual mark (or the copy imported from the previous system)
 * says the person delivered it some other way: only they know.
 */
export function creditNoteDelivery(
  deliveries: readonly CreditNoteDeliveryRow[],
  forwardedToCollection: boolean,
): CreditNoteDelivery {
  if (forwardedToCollection) return 'delivered'
  if (deliveries.some((d) => d.channel === 'email' && d.status !== 'failed')) return 'delivered'
  if (deliveries.some((d) => d.channel !== 'email' && (d.status === 'marked_sent' || d.status === 'sent'))) {
    return 'marked_sent'
  }
  return 'none'
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/** The original's fields its restored status is read from. */
export type UncreditOriginal = Pick<Invoice, 'total' | 'paid_amount'> & {
  deduction_total?: number | null
  deduction_reclaimed_total?: number | null
}

/**
 * The status and remaining amount a credited invoice returns to once its
 * credit is undone, from what is paid on it. Pure.
 *
 * A credit takes only an unpaid or a fully paid invoice
 * (isCreditableInvoiceStatus) and leaves paid_amount as it was, so this is
 * the status it had: 'paid' when the customer's share is covered,
 * 'partially_paid' when part of it is, else 'sent' (every screen derives
 * overdue from the due date). The remaining amount is the customer's share,
 * net of a ROT/RUT deduction (lib/bookkeeping/customer-share.ts), floored at
 * zero as the column is.
 */
export function invoiceStatusAfterUncredit(
  original: UncreditOriginal,
): { status: 'sent' | 'partially_paid' | 'paid'; remaining_amount: number } {
  const paid = Number(original.paid_amount ?? 0) || 0
  const remaining = Math.max(
    0,
    invoiceCustomerOutstanding(
      {
        total: Number(original.total ?? 0) || 0,
        deduction_total: original.deduction_total ?? 0,
        deduction_reclaimed_total: original.deduction_reclaimed_total ?? 0,
      },
      paid,
    ),
  )
  if (paid <= 0) return { status: 'sent', remaining_amount: remaining }
  return { status: remaining <= 0 ? 'paid' : 'partially_paid', remaining_amount: remaining }
}

// ---------------------------------------------------------------------------
// Uncredit
// ---------------------------------------------------------------------------

/** The credit note row this module reads. */
interface CreditNoteRow {
  id: string
  invoice_number: string | null
  status: string
  journal_entry_id: string | null
  paid_amount: number | null
  creation_complete: boolean | null
}

const CREDIT_NOTE_COLUMNS = 'id, invoice_number, status, journal_entry_id, paid_amount, creation_complete'

export interface UncreditInvoiceInput {
  /**
   * The person attests that a credit note marked as sent never reached the
   * customer. Required only for one that is marked sent.
   */
  attestNotDelivered?: boolean
}

export interface UncreditInvoiceResult {
  /** The original after the undo (unchanged when changed=false). */
  invoice: Invoice
  /** False when the invoice was not credited (an idempotent no-op). */
  changed: boolean
  /** The credit note kept as undone, when there was one. */
  credit_note_id: string | null
  /** The storno this call posted; null when none was needed. */
  reversal_entry_id: string | null
}

export async function uncreditInvoice(
  ctx: OperationContext,
  invoiceId: string,
  input: UncreditInvoiceInput = {},
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<UncreditInvoiceResult>> {
  const { supabase, companyId, userId, log } = ctx

  const { data: row, error: readError } = await supabase
    .from('invoices')
    .select('*')
    .eq('id', invoiceId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (readError) return failed(readError)
  if (!row) return { ok: false, code: 'INVOICE_NOT_FOUND' }
  const original = row as Invoice

  // Idempotent no-op: an invoice that is not credited, a credit note (it
  // rests at 'sent', never 'credited') among them, answers the row as it is.
  if (original.status !== 'credited' || isCreditNoteDocument(original)) {
    if (options.dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          invoice_id: original.id,
          status: original.status,
          changed: false,
          will: 'change nothing: the invoice is not credited',
        },
      }
    }
    return { ok: true, data: { invoice: original, changed: false, credit_note_id: null, reversal_entry_id: null } }
  }

  // The credit is undone only when it is one issued credit note: two
  // (partial credits), one still a draft or an imported one at rest in
  // 'credited' is not a credit this restores.
  const { data: creditRows, error: creditError } = await supabase
    .from('invoices')
    .select(CREDIT_NOTE_COLUMNS)
    .eq('company_id', companyId)
    .eq('credited_invoice_id', original.id)
    .neq('status', 'cancelled')
  if (creditError) return failed(creditError)
  const creditNotes = ((creditRows ?? []) as CreditNoteRow[]).filter(isActiveCreditNote)
  const creditNote = creditNotes.length === 1 ? creditNotes[0] : null
  if (!creditNote || !(REFUNDABLE_CREDIT_NOTE_STATUSES as readonly string[]).includes(creditNote.status)) {
    return {
      ok: false,
      code: 'INVOICE_UNCREDIT_NOT_REVERSIBLE',
      details: { reason: 'credit_note_state', credit_notes: creditNotes.length },
    }
  }
  const creditNoteDetails = { credit_note_id: creditNote.id, credit_note_number: creditNote.invoice_number }

  // A refund pays the credit back to the customer (refund-credit-note.ts):
  // while it stands the credit is settled, not undoable. Its storno gives
  // the credit note its paid amount back (payment-sync).
  if (Math.abs(Number(creditNote.paid_amount ?? 0)) >= 0.005) {
    return { ok: false, code: 'INVOICE_UNCREDIT_REFUNDED', details: creditNoteDetails }
  }

  const [deliveries, forwards, schedules, decisions] = await Promise.all([
    supabase.rpc('list_invoice_delivery_summaries', { p_company_id: companyId, p_invoice_id: creditNote.id }),
    supabase
      .from('collection_payment_forwards')
      .select('id')
      .eq('company_id', companyId)
      .eq('kind', 'credit_note')
      .eq('credit_invoice_id', creditNote.id)
      .not('forwarded_at', 'is', null)
      .limit(1),
    // The credit ended the original's periodiseringar (cancelSchedulesForSource)
    // and released a befarad kundförlust reserve (releaseDoubtfulReserveAfterChange):
    // neither comes back with the storno.
    supabase.from('accrual_schedules').select('id').eq('company_id', companyId).eq('invoice_id', original.id).limit(1),
    supabase.from('invoice_write_offs').select('id').eq('company_id', companyId).eq('invoice_id', original.id).limit(1),
  ])
  // Each read fails closed: an unread delivery is not an absent one.
  for (const read of [deliveries, forwards, schedules, decisions]) {
    if (read.error) return failed(read.error)
  }
  if ((schedules.data ?? []).length > 0) {
    return { ok: false, code: 'INVOICE_UNCREDIT_NOT_REVERSIBLE', details: { ...creditNoteDetails, reason: 'accrual_schedules' } }
  }
  if ((decisions.data ?? []).length > 0) {
    return { ok: false, code: 'INVOICE_UNCREDIT_NOT_REVERSIBLE', details: { ...creditNoteDetails, reason: 'customer_loss' } }
  }

  const delivery = creditNoteDelivery(
    (deliveries.data ?? []) as CreditNoteDeliveryRow[],
    (forwards.data ?? []).length > 0,
  )
  if (delivery === 'delivered') {
    return {
      ok: false,
      code: 'INVOICE_UNCREDIT_DELIVERED',
      details: { ...creditNoteDetails, copy_from_invoice_id: original.id },
    }
  }
  const attestationRequired = delivery === 'marked_sent'
  if (attestationRequired && !options.dryRun && input.attestNotDelivered !== true) {
    return { ok: false, code: 'INVOICE_UNCREDIT_ATTESTATION_REQUIRED', details: creditNoteDetails }
  }

  // The credit's standing verifikat: the credit note's own, or the live
  // correction of it after a rättelse. None when it is stornoed already (by
  // hand, or a run that stopped after its storno) or was never posted
  // (kontantmetoden, an unpaid original).
  let standingEntryId: string | null = null
  if (creditNote.journal_entry_id) {
    let live
    try {
      live = await liveEntryOf(supabase, companyId, creditNote.journal_entry_id)
    } catch (error) {
      return failed(error)
    }
    if ('exhausted' in live) return failed(new Error('credit note verifikat: correction chain too long'))
    if ('id' in live) standingEntryId = live.id
  }

  const restored = invoiceStatusAfterUncredit(original)

  if (options.dryRun) {
    let storno: { voucher: string | null; date: string } | null = null
    if (standingEntryId) {
      const { data: entry, error: entryError } = await supabase
        .from('journal_entries')
        .select('entry_date, voucher_series, voucher_number')
        .eq('id', standingEntryId)
        .eq('company_id', companyId)
        .maybeSingle()
      if (entryError || !entry) return failed(entryError ?? new Error('credit note verifikat not found'))
      // The storno is dated on the verifikat's own date: a locked or closed
      // period refuses it at commit, so the preview refuses it too.
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
      storno = { voucher: entry.voucher_number ? formatVoucher(entry) : null, date: entry.entry_date as string }
    }
    return {
      ok: true,
      dryRun: true,
      preview: {
        invoice_id: original.id,
        invoice_number: original.invoice_number,
        changed: true,
        ...creditNoteDetails,
        delivery,
        attestation_required: attestationRequired,
        posts_storno: storno !== null,
        credit_voucher: storno?.voucher ?? null,
        storno_date: storno?.date ?? null,
        restored_status: restored.status,
        remaining_amount: restored.remaining_amount,
        will: storno
          ? "post a storno cancelling the credit note's verifikat, keep the credit note as undone and restore the invoice"
          : 'keep the credit note as undone and restore the invoice; no verifikat to cancel',
      },
    }
  }

  let reversalEntryId: string | null = null
  if (standingEntryId) {
    const entryId = standingEntryId
    try {
      const reversal = await postingPort.reverseJournalEntry({
        supabase,
        companyId,
        userId,
        entryId,
        event: () =>
          voucherStornoBusinessEvent({ entryId, occurredOn: todayIsoStockholm(), linkBasis: linkBasisColumns('user_created') }),
        role: 'reversal',
      })
      reversalEntryId = reversal.id
    } catch (error) {
      // Stornoed since it was read (a concurrent undo): the rest follows.
      // Anything else (a locked period, a missing account) refuses with the
      // engine's own answer, before the registers change.
      if (!(error instanceof CannotReverseNonPostedError || error instanceof EntryAlreadyReversedError)) {
        return failed(error)
      }
    }
  }

  // Compare-and-set on the issued statuses. Already undone (a concurrent or
  // an earlier, interrupted run) is fine; anything else changed under us.
  const { data: undone, error: undoError } = await supabase
    .from('invoices')
    .update({ status: 'cancelled', credit_undone_at: new Date().toISOString() })
    .eq('id', creditNote.id)
    .eq('company_id', companyId)
    .in('status', [...REFUNDABLE_CREDIT_NOTE_STATUSES])
    .select('id')
  if (undoError) {
    log.error('uncredit: keeping the credit note as undone failed', undoError, { invoiceId, creditNoteId: creditNote.id })
    return failed(undoError, { reversal_entry_id: reversalEntryId })
  }
  if (!undone || undone.length === 0) {
    const { data: now } = await supabase
      .from('invoices')
      .select('status, credit_undone_at')
      .eq('id', creditNote.id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (!now?.credit_undone_at) {
      return failed(new Error('credit note changed while its credit was undone'), { reversal_entry_id: reversalEntryId })
    }
  }

  const { data: updated, error: restoreError } = await supabase
    .from('invoices')
    .update({ status: restored.status, remaining_amount: restored.remaining_amount })
    .eq('id', original.id)
    .eq('company_id', companyId)
    .eq('status', 'credited')
    .select()
  if (restoreError) {
    log.error('uncredit: restoring the original failed', restoreError, { invoiceId })
    return failed(restoreError, { reversal_entry_id: reversalEntryId })
  }
  let invoice = ((updated ?? []) as Invoice[])[0] ?? null
  if (!invoice) {
    // Restored by a concurrent run: answer the row as it is now.
    const { data: current, error: currentError } = await supabase
      .from('invoices')
      .select('*')
      .eq('id', original.id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (currentError || !current) return failed(currentError ?? new Error('invoice not found after uncredit'))
    invoice = current as Invoice
  }

  try {
    await eventBus.emit({
      type: 'invoice.uncredited',
      payload: {
        invoice,
        creditNoteId: creditNote.id,
        reversalEntryId,
        deliveryBasis: attestationRequired ? 'attested_not_delivered' : 'no_delivery',
        userId,
        companyId,
      },
    })
  } catch (error) {
    // The undo stands; the books and both rows already say so.
    log.warn('invoice.uncredited emit failed after a completed undo', error as Error)
  }

  return {
    ok: true,
    data: { invoice, changed: true, credit_note_id: creditNote.id, reversal_entry_id: reversalEntryId },
  }
}
