import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createClient } from '@/lib/supabase/server'
import { createSupplierInvoiceRegistrationEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { createSchedulesForSupplierInvoice } from '@/lib/bookkeeping/accruals/from-invoices'
import { findSupplierInvoiceMatch } from '@/lib/invoices/supplier-invoice-matching'
import { logMatchEvent } from '@/lib/invoices/match-log'
import { createLogger } from '@/lib/logger'
import type { SupplierInvoice, SupplierInvoiceItem, Transaction } from '@/types'

const log = createLogger('supplier-invoice-handler')

/**
 * Core event handler: creates a registration journal entry when a supplier
 * invoice is confirmed (accrual method only).
 *
 * This decouples journal entry creation from the invoice-inbox extension,
 * making it a core concern triggered by the `supplier_invoice.confirmed` event.
 */
async function handleSupplierInvoiceConfirmed(
  payload: EventPayload<'supplier_invoice.confirmed'>
): Promise<void> {
  const { supplierInvoice, userId, companyId } = payload

  // Guard: the inbox convert flow (and app/api/supplier-invoices) creates the
  // registration entry inline before emitting. Without this short-circuit we
  // double-post to 2440/2641/expense and overwrite registration_journal_entry_id.
  if (supplierInvoice.registration_journal_entry_id) return

  const supabase = await createClient()

  // Re-fetch to catch callers whose in-memory payload is stale (invoice-inbox
  // updates the row after insert but emits the pre-update object).
  const { data: current } = await supabase
    .from('supplier_invoices')
    .select('registration_journal_entry_id')
    .eq('id', supplierInvoice.id)
    .single()

  if (current?.registration_journal_entry_id) return

  const { data: settings } = await supabase
    .from('company_settings')
    .select('accounting_method')
    .eq('company_id', companyId)
    .single()

  const accountingMethod = settings?.accounting_method || 'accrual'
  if (accountingMethod !== 'accrual') return

  // Fetch invoice items
  const { data: items, error: itemsError } = await supabase
    .from('supplier_invoice_items')
    .select('*')
    .eq('supplier_invoice_id', supplierInvoice.id)
    .order('sort_order')

  if (itemsError || !items || items.length === 0) {
    log.error('Failed to fetch invoice items:', itemsError)
    return
  }

  // Fetch supplier type
  const { data: supplier } = await supabase
    .from('suppliers')
    .select('supplier_type')
    .eq('id', supplierInvoice.supplier_id)
    .single()

  const supplierType = supplier?.supplier_type || 'swedish_business'

  try {
    const journalEntry = await createSupplierInvoiceRegistrationEntry(
      supabase,
      companyId,
      userId,
      supplierInvoice,
      items as SupplierInvoiceItem[],
      supplierType
    )

    if (journalEntry) {
      await supabase
        .from('supplier_invoices')
        .update({ registration_journal_entry_id: journalEntry.id })
        .eq('id', supplierInvoice.id)

      // Lines with a periodisering period get their schedule + catch-up
      // dissolutions. Idempotent per line, so a replayed event is safe.
      const scheduleResult = await createSchedulesForSupplierInvoice(
        supabase,
        companyId,
        userId,
        supplierInvoice,
        items as SupplierInvoiceItem[],
        journalEntry.id,
      )
      if (scheduleResult.failed > 0) {
        log.error('accrual schedule creation failed for confirmed supplier invoice', {
          supplierInvoiceId: supplierInvoice.id,
          failed: scheduleResult.failed,
        })
      }
    }
  } catch (err) {
    log.error('Failed to create registration journal entry:', err)
  }
}

/**
 * Retroactive match: when a supplier invoice is registered or approved, scan
 * recent unmatched expense transactions for the bank payment that settles it.
 *
 * The forward direction (a freshly imported tx scanning existing invoices) lives
 * in lib/transactions/ingest.ts. This is the mirror: needed because a Bankgiro
 * payment is often imported BEFORE the invoice is registered, and nothing
 * re-matched it afterwards (the reported RosholmDell case). Reuses the same
 * `findSupplierInvoiceMatch` scorer (one invoice, many txs) so the two
 * directions can never score differently.
 *
 * Writes a SUGGESTION (potential_supplier_invoice_id), never an auto-link
 * (supplier_invoice_id): the match card / confirm dialog only surfaces for the
 * suggestion column (transactions page + lib/worklist), and the product choice
 * is "pre-fill, confirm to book": the user reviews and posts the verifikat.
 * Setting supplier_invoice_id directly would skip that confirmation and strand
 * the payment unbooked. This handler therefore never creates a journal entry.
 */
async function handleSupplierInvoiceRetroMatch(
  // .registered and .approved share this payload shape.
  payload: EventPayload<'supplier_invoice.registered'>
): Promise<void> {
  const { supplierInvoice, userId, companyId } = payload

  try {
    const supabase = await createClient()

    // Re-fetch with the supplier relation (the scorer reads bankgiro/plusgiro/
    // name): the emitted payload can be stale or lack the join.
    const { data: invoice } = await supabase
      .from('supplier_invoices')
      .select('*, supplier:suppliers(*)')
      .eq('id', supplierInvoice.id)
      .eq('company_id', companyId)
      .single()

    if (!invoice) return
    if (!['registered', 'approved'].includes(invoice.status)) return
    if ((invoice.remaining_amount ?? invoice.total) <= 0) return
    if (invoice.transaction_id) return // already settled by a bank tx

    // Idempotency: if a tx already points at this invoice (a prior retro run, or
    // ingest's forward match), don't add a competing suggestion.
    const { count: linkedCount } = await supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('supplier_invoice_id', invoice.id)
    if (linkedCount && linkedCount > 0) return

    // Bound the scan: ~90 days before the invoice/due date covers normal terms
    // and the early-payment case, without trawling the whole ledger.
    const anchor = invoice.invoice_date || invoice.due_date
    if (!anchor) return
    const anchorMs = new Date(anchor).getTime()
    const lowDate = new Date(anchorMs - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

    const { data: candidates } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
      .is('supplier_invoice_id', null)
      .is('potential_supplier_invoice_id', null)
      .is('journal_entry_id', null)
      .lt('amount', 0)
      .gte('date', lowDate)
      .order('date', { ascending: false })
      .limit(200)

    if (!candidates || candidates.length === 0) return

    // Pick the best candidate: highest confidence, tie-break on the payment
    // closest to the invoice date.
    let best: { tx: Transaction; confidence: number; matchMethod: string } | null = null
    for (const tx of candidates) {
      const match = findSupplierInvoiceMatch(tx as Transaction, [invoice as SupplierInvoice])
      if (!match) continue
      const closer =
        best !== null &&
        match.confidence === best.confidence &&
        Math.abs(new Date(tx.date).getTime() - anchorMs) <
          Math.abs(new Date(best.tx.date).getTime() - anchorMs)
      if (!best || match.confidence > best.confidence || closer) {
        best = { tx: tx as Transaction, confidence: match.confidence, matchMethod: match.matchMethod }
      }
    }

    if (!best) return

    // Suggestion only. The `.is('supplier_invoice_id', null)` guard avoids a
    // race where the tx was linked between the scan and this write.
    await supabase
      .from('transactions')
      .update({ potential_supplier_invoice_id: invoice.id })
      .eq('id', best.tx.id)
      .is('supplier_invoice_id', null)

    logMatchEvent(supabase, userId, best.tx.id, 'auto_suggested', {
      supplierInvoiceId: invoice.id,
      matchConfidence: best.confidence,
      matchMethod: best.matchMethod,
    })
  } catch (err) {
    // Never break invoice registration: this is a best-effort convenience.
    log.error('Retroactive supplier-invoice match failed:', err)
  }
}

/**
 * Register the core supplier invoice handlers on the event bus.
 * Returns a combined unsubscribe function.
 */
export function registerSupplierInvoiceHandler(): () => void {
  const unsubscribers = [
    eventBus.on('supplier_invoice.confirmed', handleSupplierInvoiceConfirmed),
    eventBus.on('supplier_invoice.registered', handleSupplierInvoiceRetroMatch),
    eventBus.on('supplier_invoice.approved', handleSupplierInvoiceRetroMatch),
  ]
  return () => unsubscribers.forEach((unsub) => unsub())
}
