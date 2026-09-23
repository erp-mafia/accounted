import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { getInvoiceReferencesForJournalEntries } from '@/lib/core/bookkeeping/journal-entry-references'

const uuidSchema = z.string().uuid()

/**
 * GET /api/documents/counts?journal_entry_ids=id1,id2,...
 * Returns underlag counts per journal entry ID.
 * Max 50 IDs per request; every ID must be a UUID (the ids are interpolated
 * into a PostgREST .or() filter string, so validation doubles as injection
 * protection).
 *
 * `data` counts BOTH direct attachments (document_attachments.journal_entry_id)
 * and documents retained on a supplier invoice that references the entry
 * (registration/payment FK or a supplier_invoice_payments row). BFL 5 kap 7 §
 * accepts underlag via hänvisning, and the expanded-row view
 * (JournalEntryAttachments) already lists referenced docs: counting only
 * direct links here made the list warning disagree with the opened row.
 * A referenced doc counts only when ANCHORED to a journal entry
 * (journal_entry_id set): unanchored docs sit outside the WORM deletion
 * guards, so they must not silence the missing-underlag warning (mirrors the
 * verifikat_without_documents RPC). Documents are deduplicated per entry so a
 * doc that is both directly linked and referenced counts once.
 *
 * `invoice_references` counts, per requested entry, the customer invoices
 * that point at it (invoices.journal_entry_id or an invoice_payments row):
 * the customer-side hänvisning (#2298). Kept apart from `data` because a
 * register invoice is not a document row: the list must not offer a
 * paperclip with nothing behind it, but it must stop warning "Underlag
 * saknas" for an entry the verifikat page already lists an invoice on.
 * Same verdict as the RPC's customer arm and the verifikat detail page.
 */
export const GET = withRouteContext('document.counts', async (request, ctx) => {
  const { supabase, companyId } = ctx

  const { searchParams } = new URL(request.url)
  const idsParam = searchParams.get('journal_entry_ids')

  if (!idsParam) {
    return NextResponse.json({ error: 'journal_entry_ids is required' }, { status: 400 })
  }

  const ids = idsParam.split(',').filter(Boolean)

  if (ids.length === 0) {
    return NextResponse.json({ data: {} })
  }

  if (ids.length > 50) {
    return NextResponse.json({ error: 'Maximum 50 IDs per request' }, { status: 400 })
  }

  if (ids.some((id) => !uuidSchema.safeParse(id).success)) {
    return NextResponse.json(
      { error: 'journal_entry_ids must be UUIDs' },
      { status: 400 },
    )
  }

  const inList = `(${ids.join(',')})`
  const [directRes, siRes, sipRes] = await Promise.all([
    supabase
      .from('document_attachments')
      .select('id, journal_entry_id')
      .eq('company_id', companyId)
      .eq('is_current_version', true)
      .in('journal_entry_id', ids),
    supabase
      .from('supplier_invoices')
      .select(
        'document_id, registration_journal_entry_id, payment_journal_entry_id, document:document_attachments(journal_entry_id)',
      )
      .eq('company_id', companyId)
      .not('document_id', 'is', null)
      .or(
        `registration_journal_entry_id.in.${inList},payment_journal_entry_id.in.${inList}`,
      ),
    supabase
      .from('supplier_invoice_payments')
      .select(
        'journal_entry_id, supplier_invoice:supplier_invoices(document_id, document:document_attachments(journal_entry_id))',
      )
      .eq('company_id', companyId)
      .in('journal_entry_id', ids),
  ])

  if (directRes.error) {
    return NextResponse.json({ error: getUserErrorMessage(directRes.error) }, { status: 500 })
  }
  if (siRes.error) {
    return NextResponse.json({ error: getUserErrorMessage(siRes.error) }, { status: 500 })
  }
  if (sipRes.error) {
    return NextResponse.json({ error: getUserErrorMessage(sipRes.error) }, { status: 500 })
  }

  // Distinct doc ids per entry: a supplier invoice's document referenced from
  // both FK paths, or already directly linked, must not double count.
  const docsByEntry = new Map<string, Set<string>>()
  const add = (journalEntryId: string | null | undefined, documentId: string | null | undefined) => {
    if (!journalEntryId || !documentId) return
    let set = docsByEntry.get(journalEntryId)
    if (!set) {
      set = new Set<string>()
      docsByEntry.set(journalEntryId, set)
    }
    set.add(documentId)
  }

  for (const row of (directRes.data ?? []) as { id: string; journal_entry_id: string | null }[]) {
    add(row.journal_entry_id, row.id)
  }
  for (const row of (siRes.data ?? []) as unknown as {
    document_id: string | null
    registration_journal_entry_id: string | null
    payment_journal_entry_id: string | null
    document: { journal_entry_id: string | null } | null
  }[]) {
    if (!row.document?.journal_entry_id) continue // unanchored: not underlag
    add(row.registration_journal_entry_id, row.document_id)
    add(row.payment_journal_entry_id, row.document_id)
  }
  for (const row of (sipRes.data ?? []) as unknown as {
    journal_entry_id: string | null
    supplier_invoice: {
      document_id: string | null
      document: { journal_entry_id: string | null } | null
    } | null
  }[]) {
    if (!row.supplier_invoice?.document?.journal_entry_id) continue // unanchored
    add(row.journal_entry_id, row.supplier_invoice.document_id)
  }

  let invoiceRefs: Map<string, string[]>
  try {
    invoiceRefs = await getInvoiceReferencesForJournalEntries(supabase, companyId, ids)
  } catch (err) {
    return NextResponse.json({ error: getUserErrorMessage(err) }, { status: 500 })
  }

  // Referenced entries outside the requested set (an SI FK can point at an
  // entry the caller didn't ask about) must not leak into the response.
  const requested = new Set(ids)
  const counts: Record<string, number> = {}
  for (const [journalEntryId, docIds] of docsByEntry) {
    if (requested.has(journalEntryId)) counts[journalEntryId] = docIds.size
  }
  const invoiceReferences: Record<string, number> = {}
  for (const [journalEntryId, invoiceIds] of invoiceRefs) {
    if (requested.has(journalEntryId)) invoiceReferences[journalEntryId] = invoiceIds.length
  }

  return NextResponse.json({ data: counts, invoice_references: invoiceReferences })
})
