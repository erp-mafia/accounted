/**
 * Reclaim the share of a ROT/RUT begäran that Skatteverket refused.
 *
 * Under fakturamodellen the deduction is a fordran on Skatteverket (1513)
 * from the day the invoice is issued. A beslut that refuses an ärende, fully
 * (avslag) or in part, does not make that fordran disappear: the buyer owes
 * the refused share (HUSFL 2009:194; swedish-invoice-compliance section 8:
 * "SKV denies: Debit 1510, Credit 1513, re-invoice customer"). Before this
 * service the request was only marked rejected / partially_paid and the
 * refused kronor stayed on 1513 while the invoice read as paid.
 *
 * What one call does, for one begäran:
 *   1. Works out the refused share per invoice from the recorded beslut:
 *      requested_amount minus decided_amount per item. A full avslag
 *      (decided_total 0) refuses every item; a single-item begäran needs no
 *      per-item split; a multi-item begäran whose beslut was recorded as one
 *      total (PATCH partially_paid) is refused with SPLIT_UNKNOWN: the split
 *      is Skatteverket's, never guessed (import the beslutsfil).
 *   2. Books ONE voucher: debit 1510 / credit 1513 per invoice
 *      (createRotRutReclaimEntry, source_type rot_rut_reclaim).
 *   3. CAS-attaches it to the request (reclaim_journal_entry_id IS NULL), so
 *      two concurrent reclaims cannot both stand; the partial unique index
 *      journal_entries_rot_rut_reclaim_live_unique backs this at the journal.
 *   4. Reopens every invoice for its refused share: deduction_reclaimed_total
 *      grows, remaining_amount is re-derived through invoiceCustomerOutstanding
 *      (the one definition), status goes back to partially_paid (the customer
 *      already paid their share) or sent/overdue.
 *
 * Refusals before any write: no beslut, nothing refused, already reclaimed,
 * unknown split, an invoice without a verifikat (no 1513 debit exists to
 * move: kontantmetod invoice never paid, or deferred booking), a cancelled or
 * credited invoice, a non-SEK invoice (1513 is a kronor account).
 *
 * The invoice document is left as issued: the customer got an invoice with
 * a deduction on it, and that stays true; what changes is who owes the
 * refused share. A separate follow-up (påminnelse) tells the customer.
 *
 * The voucher IS the accounting record: engine failure blocks the whole
 * operation. Everything after the voucher is best-effort-with-loud-logging,
 * never an unbook (the voucher is immutable per BFL).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRotRutReclaimEntry, type RotRutReclaimLeg } from '@/lib/bookkeeping/rot-rut-entries'
import { invoiceCustomerOutstanding } from '@/lib/invoices/customer-share'
import { roundOre } from '@/lib/money'
import { createLogger } from '@/lib/logger'

const log = createLogger('invoices/rot-rut-reclaim')

export interface ReclaimRotRutRefusalParams {
  requestId: string
  /** Entry date of the reclaim voucher (the beslut date, or today). */
  bookingDate: string
}

export type ReclaimRotRutErrorCode =
  | 'ROT_RUT_REQUEST_NOT_FOUND'
  | 'ROT_RUT_SETTLE_INVALID_STATE'
  | 'ROT_RUT_RECLAIM_NO_BESLUT'
  | 'ROT_RUT_RECLAIM_NOTHING_REFUSED'
  | 'ROT_RUT_RECLAIM_ALREADY_DONE'
  | 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN'
  | 'ROT_RUT_RECLAIM_INVOICE_NOT_BOOKED'
  | 'ROT_RUT_RECLAIM_INVOICE_NOT_OPEN'
  | 'ROT_RUT_RECLAIM_CURRENCY'
  | 'ROT_RUT_RECLAIM_INVOICE_REREQUESTED'
  | 'ROT_RUT_RECLAIM_RACE'

export interface ReclaimedInvoice {
  invoice_id: string
  invoice_number: string | null
  reclaimed_amount: number
  remaining_amount: number
  status: string
}

export type ReclaimRotRutRefusalOutcome =
  | {
      ok: true
      journalEntryId: string
      reclaimedTotal: number
      invoices: ReclaimedInvoice[]
    }
  | { ok: false; kind: 'code'; code: ReclaimRotRutErrorCode; details?: Record<string, unknown> }
  | { ok: false; kind: 'error'; error: unknown; stage: 'fetch' | 'book' | 'update' }

/** Invoice statuses a refused share can reopen. */
const REOPENABLE_INVOICE_STATUSES = ['paid', 'partially_paid', 'sent', 'overdue'] as const

interface RequestRow {
  id: string
  name: string
  deduction_type: 'rot' | 'rut'
  status: string
  requested_total: number | string
  decided_total: number | string | null
  decided_at: string | null
  reclaim_journal_entry_id: string | null
}

interface InvoiceRow {
  id: string
  invoice_number: string | null
  status: string
  currency: string | null
  total: number | string
  paid_amount: number | string | null
  deduction_total: number | string | null
  deduction_reclaimed_total: number | string | null
  journal_entry_id: string | null
  document_type: string | null
}

interface ItemRow {
  id: string
  invoice_id: string
  requested_amount: number | string
  decided_amount: number | string | null
  reclaimed_amount: number | string | null
  invoice: InvoiceRow | null
}

export interface RefusedShare {
  itemId: string
  invoiceId: string
  refused: number
}

/**
 * Pure: the refused share per item from the recorded beslut, or the reason
 * it cannot be known. Exported for the overview page, which shows "nekat att
 * bokföra" per request without booking anything.
 */
export function computeRefusedShares(
  request: Pick<RequestRow, 'requested_total' | 'decided_total' | 'decided_at'>,
  items: Array<Pick<ItemRow, 'id' | 'invoice_id' | 'requested_amount' | 'decided_amount'>>,
):
  | { ok: true; shares: RefusedShare[]; total: number }
  | { ok: false; code: 'ROT_RUT_RECLAIM_NO_BESLUT' | 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' } {
  if (!request.decided_at || request.decided_total == null) {
    return { ok: false, code: 'ROT_RUT_RECLAIM_NO_BESLUT' }
  }
  const decidedTotal = roundOre(Number(request.decided_total))
  const requestedTotal = roundOre(Number(request.requested_total))
  const fullRefusal = decidedTotal <= 0

  const shares: RefusedShare[] = []
  for (const item of items) {
    const requested = roundOre(Number(item.requested_amount))
    let decided: number
    if (fullRefusal) {
      decided = 0
    } else if (item.decided_amount != null) {
      decided = roundOre(Number(item.decided_amount))
    } else if (items.length === 1) {
      // One ärende: the request total IS the item's beslut.
      decided = decidedTotal
    } else {
      return { ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' }
    }
    const refused = roundOre(Math.max(0, Math.min(requested, requested - decided)))
    shares.push({ itemId: item.id, invoiceId: item.invoice_id, refused })
  }
  // The per-item shares ARE what gets booked, so they must reconcile with the
  // request-level beslut to the öre. Items decided at less than the header
  // says (or more) mean the recorded beslut is inconsistent: refuse, never
  // book legs that sum to something else than the refused total.
  const total = roundOre(shares.reduce((sum, s) => sum + s.refused, 0))
  const refusedByHeader = roundOre(Math.max(0, requestedTotal - decidedTotal))
  if (Math.abs(total - refusedByHeader) > 0.005) {
    return { ok: false, code: 'ROT_RUT_RECLAIM_SPLIT_UNKNOWN' }
  }
  return { ok: true, shares, total }
}

/**
 * What the customer has paid on the invoice. `paid_amount` is nullable in the
 * schema; a `paid` invoice with a NULL column (older settlement paths) has by
 * definition settled its customer share, so that share stands in for the
 * missing figure instead of reopening the whole invoice.
 */
function customerPaidAmount(invoice: Pick<InvoiceRow, 'status' | 'paid_amount' | 'total' | 'deduction_total'>): number {
  if (invoice.paid_amount != null) return roundOre(Number(invoice.paid_amount))
  if (invoice.status === 'paid') {
    return roundOre(Number(invoice.total) - Number(invoice.deduction_total ?? 0))
  }
  return 0
}

/** Status of a reopened invoice: the customer's own share is still (partly) paid. */
function reopenedStatus(invoice: InvoiceRow, newRemaining: number): string {
  if (newRemaining <= 0) return invoice.status
  if (customerPaidAmount(invoice) > 0) return 'partially_paid'
  return invoice.status === 'overdue' ? 'overdue' : 'sent'
}

/**
 * Invoices of this begäran that sit in ANOTHER begäran Skatteverket has not
 * refused or the company has not cancelled. Avslag → new file is the normal
 * retry (payout-requests/[id]/route.ts): while the invoice is re-requested,
 * the refused share is being reviewed again and must not be booked onto the
 * customer (skeptic #2397 C2). Returns the invoice ids, or the raw error.
 */
export async function findRerequestedInvoiceIds(
  supabase: SupabaseClient,
  companyId: string,
  requestId: string,
  invoiceIds: string[],
): Promise<{ ids: string[]; error: unknown }> {
  if (invoiceIds.length === 0) return { ids: [], error: null }
  const { data, error } = await supabase
    .from('rot_rut_payout_request_items')
    .select('invoice_id, request:rot_rut_payout_requests!inner(id, status, company_id)')
    .eq('request.company_id', companyId)
    .neq('request_id', requestId)
    .in('invoice_id', invoiceIds)
    .not('request.status', 'in', '("cancelled","rejected")')
  if (error) return { ids: [], error }
  const ids = [...new Set(((data ?? []) as Array<{ invoice_id: string }>).map((row) => row.invoice_id))]
  return { ids, error: null }
}

export async function reclaimRotRutRefusal(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  params: ReclaimRotRutRefusalParams,
): Promise<ReclaimRotRutRefusalOutcome> {
  const { data: request, error: fetchError } = await supabase
    .from('rot_rut_payout_requests')
    .select(
      'id, name, deduction_type, status, requested_total, decided_total, decided_at, reclaim_journal_entry_id',
    )
    .eq('company_id', companyId)
    .eq('id', params.requestId)
    .maybeSingle()
  if (fetchError) return { ok: false, kind: 'error', error: fetchError, stage: 'fetch' }
  if (!request) return { ok: false, kind: 'code', code: 'ROT_RUT_REQUEST_NOT_FOUND' }
  const req = request as RequestRow

  if (req.status === 'cancelled') {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_SETTLE_INVALID_STATE',
      details: { status: req.status, reason: 'En avbruten begäran har inget beslut att bokföra.' },
    }
  }
  // A begäran that already carries its reclaim voucher is not refused
  // outright: a failure between the voucher and the per-invoice writes leaves
  // legs whose item marker (reclaimed_amount) is still NULL, and re-running
  // completes exactly those legs through the idempotent RPC (resume mode).
  // Only when every leg is applied is the call ROT_RUT_RECLAIM_ALREADY_DONE.
  const resumeJournalEntryId = req.reclaim_journal_entry_id

  const { data: itemRows, error: itemsError } = await supabase
    .from('rot_rut_payout_request_items')
    .select(
      'id, invoice_id, requested_amount, decided_amount, reclaimed_amount, invoice:invoices(id, invoice_number, status, currency, total, paid_amount, deduction_total, deduction_reclaimed_total, journal_entry_id, document_type)',
    )
    .eq('request_id', req.id)
  if (itemsError) return { ok: false, kind: 'error', error: itemsError, stage: 'fetch' }
  const items = (itemRows ?? []) as unknown as ItemRow[]

  const computed = computeRefusedShares(req, items)
  if (!computed.ok) {
    return { ok: false, kind: 'code', code: computed.code, details: { request_id: req.id } }
  }
  const refusedShares = computed.shares.filter((share) => share.refused > 0)
  if (refusedShares.length === 0 || computed.total <= 0) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_RECLAIM_NOTHING_REFUSED',
      details: { requested_total: Number(req.requested_total), decided_total: Number(req.decided_total) },
    }
  }
  // Resume mode: only the legs whose marker is still unset are pending.
  const shares = resumeJournalEntryId
    ? refusedShares.filter((share) => {
        const item = items.find((row) => row.id === share.itemId)
        return item != null && item.reclaimed_amount == null
      })
    : refusedShares
  if (resumeJournalEntryId && shares.length === 0) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_RECLAIM_ALREADY_DONE',
      details: { journal_entry_id: resumeJournalEntryId },
    }
  }

  // An invoice Skatteverket is reviewing again (a later, live begäran) keeps
  // its refused share on 1513 until that beslut lands.
  const rerequested = await findRerequestedInvoiceIds(
    supabase,
    companyId,
    req.id,
    shares.map((share) => share.invoiceId),
  )
  if (rerequested.error) {
    return { ok: false, kind: 'error', error: rerequested.error, stage: 'fetch' }
  }
  if (rerequested.ids.length > 0) {
    return {
      ok: false,
      kind: 'code',
      code: 'ROT_RUT_RECLAIM_INVOICE_REREQUESTED',
      details: { invoice_ids: rerequested.ids },
    }
  }

  // Every invoice must be able to carry the fordran before anything books.
  const legs: Array<RotRutReclaimLeg & { item: ItemRow; invoice: InvoiceRow }> = []
  for (const share of shares) {
    const item = items.find((row) => row.id === share.itemId)!
    const invoice = item.invoice
    if (!invoice) {
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_RECLAIM_INVOICE_NOT_OPEN',
        details: { invoice_id: share.invoiceId, reason: 'invoice row missing' },
      }
    }
    if ((invoice.currency || 'SEK').toUpperCase() !== 'SEK') {
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_RECLAIM_CURRENCY',
        details: { invoice_id: invoice.id, currency: invoice.currency },
      }
    }
    if (!(REOPENABLE_INVOICE_STATUSES as readonly string[]).includes(invoice.status)) {
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_RECLAIM_INVOICE_NOT_OPEN',
        details: { invoice_id: invoice.id, status: invoice.status },
      }
    }
    // No verifikat means no 1513 debit exists for this invoice: nothing to
    // move (kontantmetod invoice never paid, deferred booking not yet booked).
    if (!invoice.journal_entry_id) {
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_RECLAIM_INVOICE_NOT_BOOKED',
        details: { invoice_id: invoice.id },
      }
    }
    const deduction = roundOre(Number(invoice.deduction_total ?? 0))
    const alreadyReclaimed = roundOre(Number(invoice.deduction_reclaimed_total ?? 0))
    const headroom = roundOre(deduction - alreadyReclaimed)
    if (share.refused > headroom + 0.005) {
      // The beslut refuses more than the invoice ever carried on 1513: a data
      // inconsistency, not something to book around.
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_RECLAIM_NOTHING_REFUSED',
        details: {
          invoice_id: invoice.id,
          refused: share.refused,
          deduction_total: deduction,
          deduction_reclaimed_total: alreadyReclaimed,
          reason: 'refused share exceeds the deduction booked on 1513',
        },
      }
    }
    legs.push({
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoice_number,
      amount: share.refused,
      item,
      invoice,
    })
  }

  let journalEntryId: string
  if (resumeJournalEntryId) {
    journalEntryId = resumeJournalEntryId
    log.warn('rot/rut reclaim resuming: voucher exists, completing unapplied invoice legs', {
      payoutRequestId: req.id,
      journalEntryId,
      pendingInvoiceIds: legs.map((leg) => leg.invoiceId),
    })
  } else {
    // The voucher is the accounting record: engine failure must block.
    try {
      const entry = await createRotRutReclaimEntry(supabase, companyId, userId, {
        requestId: req.id,
        requestName: req.name,
        deductionType: req.deduction_type,
        bookingDate: params.bookingDate,
        legs: legs.map((leg) => ({
          invoiceId: leg.invoiceId,
          invoiceNumber: leg.invoiceNumber,
          amount: leg.amount,
        })),
      })
      journalEntryId = entry.id
    } catch (engineError) {
      return { ok: false, kind: 'error', error: engineError, stage: 'book' }
    }

    // CAS on reclaim_journal_entry_id IS NULL: a concurrent reclaim must not
    // reopen the invoices twice. The loser's voucher is caught by the partial
    // unique index before it posts; this guard covers the request row itself.
    const { data: attached, error: attachError } = await supabase
      .from('rot_rut_payout_requests')
      .update({ reclaim_journal_entry_id: journalEntryId, reclaimed_at: new Date().toISOString() })
      .eq('company_id', companyId)
      .eq('id', req.id)
      .is('reclaim_journal_entry_id', null)
      .select('id')
      .maybeSingle()
    if (attachError) {
      log.error('rot/rut reclaim entry booked but request update failed', attachError as Error, {
        journalEntryId,
        payoutRequestId: req.id,
      })
      return { ok: false, kind: 'error', error: attachError, stage: 'update' }
    }
    if (!attached) {
      log.error('rot/rut reclaim entry booked but request was reclaimed concurrently', undefined, {
        journalEntryId,
        payoutRequestId: req.id,
      })
      return {
        ok: false,
        kind: 'code',
        code: 'ROT_RUT_RECLAIM_RACE',
        details: { journal_entry_id: journalEntryId, request_id: req.id },
      }
    }
  }

  // Reopen every invoice for its refused share. Each leg is one atomic,
  // idempotent RPC (apply_rot_rut_reclaim_invoice: item marker + invoice row
  // in one transaction, a set marker is a no-op), so a failure here is
  // retryable by calling again: the voucher stands (never unbook) and the
  // resume path above completes the missing legs.
  const reopened: ReclaimedInvoice[] = []
  for (const leg of legs) {
    const invoice = leg.invoice
    const newReclaimed = roundOre(Number(invoice.deduction_reclaimed_total ?? 0) + leg.amount)
    const newRemaining = Math.max(
      0,
      invoiceCustomerOutstanding(
        {
          total: Number(invoice.total),
          deduction_total: Number(invoice.deduction_total ?? 0),
          deduction_reclaimed_total: newReclaimed,
        },
        customerPaidAmount(invoice),
      ),
    )
    const newStatus = reopenedStatus(invoice, newRemaining)

    const { data: applied, error: applyError } = await supabase.rpc('apply_rot_rut_reclaim_invoice', {
      p_item_id: leg.item.id,
      p_invoice_id: invoice.id,
      p_company_id: companyId,
      p_reclaimed_amount: leg.amount,
      p_remaining_amount: newRemaining,
      p_status: newStatus,
    })
    if (applyError) {
      log.error('rot/rut reclaim booked but invoice reopen failed (retry the reclaim to resume)', applyError as Error, {
        journalEntryId,
        payoutRequestId: req.id,
        invoiceId: invoice.id,
        reclaimedAmount: leg.amount,
      })
      return { ok: false, kind: 'error', error: applyError, stage: 'update' }
    }
    if (applied === false) {
      // Marker already set by a concurrent resume: that call reported the leg.
      log.warn('rot/rut reclaim leg already applied', { itemId: leg.item.id, invoiceId: invoice.id })
      continue
    }

    reopened.push({
      invoice_id: invoice.id,
      invoice_number: invoice.invoice_number,
      reclaimed_amount: leg.amount,
      remaining_amount: newRemaining,
      status: newStatus,
    })
  }

  const reclaimedTotal = roundOre(legs.reduce((sum, leg) => sum + leg.amount, 0))
  log.info('rot/rut refused share reclaimed', {
    userId,
    payoutRequestId: req.id,
    journalEntryId,
    reclaimedTotal,
    invoiceCount: reopened.length,
  })

  return { ok: true, journalEntryId, reclaimedTotal, invoices: reopened }
}
