import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('supplier-invoice-underlag')

/**
 * Re-anchor a supplier invoice's retained source document to one of the
 * invoice's own posted verifikat when the document is currently floating
 * (document_attachments.journal_entry_id IS NULL).
 *
 * Why this exists (support case 2026-07-27): every missing-underlag surface
 * (verifikat_without_documents / transactions_without_documents RPCs,
 * /api/documents/counts, the transactions list) only accepts a referenced
 * supplier-invoice document as underlag when it is ANCHORED to a journal
 * entry, because only anchored docs sit behind the WORM deletion guards
 * (block_document_deletion keys on journal_entry_id). A floating document
 * therefore keeps "Underlag saknas" alive on a verifikat that plainly shows
 * the invoice PDF, and the user has no way to resolve it: the nag is supposed
 * to get the document anchored, but nothing anchored it.
 *
 * Documents end up floating two ways, both seen in production:
 *   1. delete_last_voucher clears journal_entry_id on every document hanging
 *      on the deleted voucher (it has to: the FK is ON DELETE RESTRICT). When
 *      that voucher was a rättelse the invoice's PDF had been relinked onto,
 *      the invoice is left holding an unanchored document while its payment
 *      verifikat is still posted.
 *   2. Payment/cash verifikat booked for an invoice whose document was never
 *      anchored at registration (attached after the fact, or booked through a
 *      path that did not link it).
 *
 * Anchoring is strictly an improvement: it puts the document behind the
 * deletion guard and makes the hänvisning (BFL 5 kap 7 §) legally solid, and
 * the immutability triggers explicitly allow NULL -> uuid
 * (enforce_document_journal_entry_immutability returns early when
 * OLD.journal_entry_id IS NULL). An already-anchored document is never moved.
 *
 * Returns the journal entry id the document was anchored to, or null when
 * nothing needed doing (no document, already anchored, no eligible verifikat).
 * Never throws: every caller runs after a committed, immutable booking, so a
 * failure here must be logged, not surfaced.
 */
export async function anchorSupplierInvoiceDocument(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
): Promise<string | null> {
  try {
    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select('id, document_id, registration_journal_entry_id, payment_journal_entry_id')
      .eq('id', supplierInvoiceId)
      .eq('company_id', companyId)
      .maybeSingle()

    const documentId = (invoice as { document_id?: string | null } | null)?.document_id
    if (!documentId) return null

    const { data: document } = await supabase
      .from('document_attachments')
      .select('id, journal_entry_id, is_current_version')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle()

    const doc = document as
      | { id: string; journal_entry_id: string | null; is_current_version: boolean }
      | null
    // Already anchored (the normal case), superseded, or gone: leave it alone.
    // Moving an anchored doc is blocked by the immutability trigger anyway.
    if (!doc || doc.journal_entry_id || doc.is_current_version !== true) return null

    const entryId = await pickAnchorEntry(
      supabase,
      companyId,
      supplierInvoiceId,
      invoice as {
        registration_journal_entry_id: string | null
        payment_journal_entry_id: string | null
      },
    )
    if (!entryId) {
      // The invoice HAS a floating retained document but no verifikat that can
      // take it. In the payment routes (which call this right after posting)
      // that is an anomaly worth a log line: prod case 2026-08-28 (Anders,
      // faktura 118776) stayed "Underlag saknas" through exactly this kind of
      // silent bail, and nothing recorded which branch gave up.
      log.warn('supplier invoice document is floating but no verifikat can anchor it', {
        companyId,
        supplierInvoiceId,
        documentId: doc.id,
      })
      return null
    }

    const { data: updatedRows, error } = await supabase
      .from('document_attachments')
      .update({ journal_entry_id: entryId })
      .eq('id', doc.id)
      .eq('company_id', companyId)
      // Concurrency guard: a parallel booking may have anchored it since the
      // read above. Never steal a document that already serves a verifikat.
      .is('journal_entry_id', null)
      .eq('is_current_version', true)
      .select('id')

    if (error) {
      log.warn('failed to anchor supplier invoice document to verifikat', {
        companyId,
        supplierInvoiceId,
        documentId: doc.id,
        journalEntryId: entryId,
        reason: error.message,
      })
      return null
    }
    // The guarded update can match zero rows (a concurrent writer got there
    // first, or RLS filtered the row). That is NOT a successful anchor: report
    // null so callers and the reconcile cron treat the document as still
    // floating instead of trusting a write that never happened.
    if (!updatedRows || updatedRows.length === 0) {
      log.warn('anchor update matched no rows; document left floating', {
        companyId,
        supplierInvoiceId,
        documentId: doc.id,
        journalEntryId: entryId,
      })
      return null
    }
    return entryId
  } catch (err) {
    log.warn('anchorSupplierInvoiceDocument threw', {
      companyId,
      supplierInvoiceId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * The invoice's own verifikat, in the order BFL wants the underlag to hang:
 * the registration booking is the primary booking of the affärshändelse, the
 * payment booking is the fallback (and the only booking under kontantmetoden),
 * then any partial-payment verifikat, oldest first.
 *
 * Only posted entries in open, unlocked periods qualify: a reversed entry is
 * no longer a live booking, and enforce_period_lock_documents rejects the
 * write outright once the period is closed or locked.
 */
async function pickAnchorEntry(
  supabase: SupabaseClient,
  companyId: string,
  supplierInvoiceId: string,
  invoice: {
    registration_journal_entry_id: string | null
    payment_journal_entry_id: string | null
  },
): Promise<string | null> {
  const candidates: string[] = []
  const push = (id: string | null | undefined) => {
    if (id && !candidates.includes(id)) candidates.push(id)
  }
  push(invoice.registration_journal_entry_id)
  push(invoice.payment_journal_entry_id)

  const { data: paymentRows } = await supabase
    .from('supplier_invoice_payments')
    .select('journal_entry_id, payment_date')
    .eq('company_id', companyId)
    .eq('supplier_invoice_id', supplierInvoiceId)
    .not('journal_entry_id', 'is', null)
    .order('payment_date', { ascending: true })

  for (const row of (paymentRows ?? []) as { journal_entry_id: string | null }[]) {
    push(row.journal_entry_id)
  }
  if (candidates.length === 0) return null

  const { data: entries } = await supabase
    .from('journal_entries')
    .select('id, status, fiscal_period:fiscal_periods(is_closed, locked_at)')
    .eq('company_id', companyId)
    .in('id', candidates)

  type EntryRow = {
    id: string
    status: string
    fiscal_period:
      | { is_closed: boolean | null; locked_at: string | null }
      | { is_closed: boolean | null; locked_at: string | null }[]
      | null
  }
  const byId = new Map<string, EntryRow>(
    ((entries ?? []) as unknown as EntryRow[]).map((entry) => [entry.id, entry]),
  )

  for (const id of candidates) {
    const entry = byId.get(id)
    if (!entry || entry.status !== 'posted') continue
    // PostgREST returns an embedded to-one either as an object or, depending
    // on how it resolves the relationship, as a single-element array.
    const period = Array.isArray(entry.fiscal_period) ? entry.fiscal_period[0] : entry.fiscal_period
    if (period?.is_closed || period?.locked_at) continue
    return id
  }
  return null
}

/**
 * Re-anchor the supplier-invoice documents that a just-deleted voucher left
 * floating. Takes the document ids that hung on the voucher before it was torn
 * down (delete_last_voucher nulls their journal_entry_id), and re-points those
 * that are a supplier invoice's retained source document at another posted
 * verifikat of the same invoice.
 *
 * Documents that belong to no supplier invoice are left floating on purpose:
 * a receipt uploaded straight to the deleted voucher SHOULD return to the
 * unlinked pool so the user can attach it to the replacement booking.
 *
 * Returns the number of documents re-anchored.
 */
export interface FloatingDocumentSweepResult {
  /** Invoices whose floating retained document was examined. */
  candidates: number
  /** Documents actually anchored to a verifikat this run. */
  anchored: number
}

/**
 * Prod-wide self-heal for retained supplier-invoice documents that stayed
 * floating although the invoice has a posted verifikat: the inline anchoring
 * in the payment routes is best-effort by design (never throws, the booking is
 * already committed), so a transient failure there strands the document until
 * something retries. Historically that "something" was a hand-written repair
 * migration (20260727180000, 20260824150000); this makes the retry a standing
 * daily cron instead. Prod case 2026-08-28 (Anders, faktura 118776): payment
 * verifikat posted, invoice document eligible on every static condition, yet
 * the inline anchor did nothing and no log recorded why, so the verifikat
 * showed "Underlag saknas" until the user re-uploaded the PDF by hand.
 *
 * Anchoring an already-shown-but-floating document is strictly an improvement
 * (it puts the file behind the WORM deletion guard and satisfies BFL 5 kap
 * 7 §), and anchorSupplierInvoiceDocument never moves an anchored document,
 * so re-running this sweep is idempotent. Locked/closed periods are skipped by
 * pickAnchorEntry, matching the repair migrations.
 *
 * Meant to run under the service-role client from a cron: RLS would otherwise
 * scope the candidate scan to one user's companies.
 */
export async function sweepFloatingSupplierInvoiceDocuments(
  supabase: SupabaseClient,
  opts: { limit?: number } = {},
): Promise<FloatingDocumentSweepResult> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000)

  // FK named explicitly: with an ambiguous relationship PostgREST rejects the
  // embed and the sweep would silently see zero candidates (the #2022 lesson).
  const { data, error } = await supabase
    .from('supplier_invoices')
    .select(
      'id, company_id, document:document_attachments!supplier_invoices_document_id_fkey!inner(id, journal_entry_id, is_current_version)',
    )
    .not('document_id', 'is', null)
    .or('payment_journal_entry_id.not.is.null,registration_journal_entry_id.not.is.null')
    .is('document.journal_entry_id', null)
    .eq('document.is_current_version', true)
    .limit(limit)

  if (error) {
    log.warn('floating-document sweep query failed', { reason: error.message })
    return { candidates: 0, anchored: 0 }
  }

  const rows = (data ?? []) as unknown as Array<{ id: string; company_id: string }>
  let anchored = 0
  for (const row of rows) {
    if (await anchorSupplierInvoiceDocument(supabase, row.company_id, row.id)) anchored++
  }
  if (rows.length > 0) {
    log.info('floating-document sweep complete', { candidates: rows.length, anchored })
  }
  return { candidates: rows.length, anchored }
}

export async function reanchorOrphanedSupplierInvoiceDocuments(
  supabase: SupabaseClient,
  companyId: string,
  documentIds: string[],
): Promise<number> {
  if (documentIds.length === 0) return 0
  try {
    const { data: invoices } = await supabase
      .from('supplier_invoices')
      .select('id')
      .eq('company_id', companyId)
      .in('document_id', documentIds)

    let anchored = 0
    for (const invoice of ((invoices ?? []) as { id: string }[])) {
      if (await anchorSupplierInvoiceDocument(supabase, companyId, invoice.id)) anchored++
    }
    return anchored
  } catch (err) {
    log.warn('reanchorOrphanedSupplierInvoiceDocuments threw', {
      companyId,
      reason: err instanceof Error ? err.message : String(err),
    })
    return 0
  }
}
