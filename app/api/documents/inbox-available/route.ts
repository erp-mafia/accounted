import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import type { InvoiceExtractionResult } from '@/types'

ensureInitialized()

/**
 * GET /api/documents/inbox-available: list invoice-inbox documents that are
 * available to attach as underlag to a verifikat.
 *
 * Returns only *unconsumed* inbox items: those that have a file but have not
 * yet become a supplier invoice, a direct journal entry, or been matched to a
 * bank transaction, and whose underlying document is not already linked to a
 * verifikation. This mirrors the inbox's own "Att göra" set, narrowed to items
 * with an attachable file. Re-pointing an already-linked document is forbidden
 * (BFL 7 kap: räkenskapsinformation is immutable), so those are excluded here
 * and the DB immutability trigger is the backstop.
 *
 * `invoice_inbox_items` is a core table, so a core route may read it directly
 * without importing from @/extensions. When the invoice-inbox extension is not
 * in use the table is simply empty and this returns [].
 */

interface InboxRow {
  id: string
  document_id: string | null
  source: string | null
  created_at: string
  extracted_data: InvoiceExtractionResult | null
}

interface DocRow {
  id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number
  journal_entry_id: string | null
  is_current_version: boolean
}

export const GET = withRouteContext('document.inbox_available', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx

  // 1) Eligible inbox items: company-scoped (defense in depth alongside RLS),
  //    unconsumed, with a document.
  const { data: inboxRows, error: inboxError } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, source, created_at, extracted_data')
    .eq('company_id', companyId)
    .not('document_id', 'is', null)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .order('created_at', { ascending: false })
    .limit(100)

  if (inboxError) {
    log.error('inbox-available item query failed', inboxError)
    return errorResponse(inboxError, log, { requestId })
  }

  const rows = (inboxRows ?? []) as InboxRow[]
  const docIds = rows.map((r) => r.document_id).filter((id): id is string => !!id)

  if (docIds.length === 0) {
    return NextResponse.json({ data: [] })
  }

  // 2) The current, still-unlinked documents behind those items. Excluding
  //    docs with a journal_entry_id (already underlag elsewhere) and superseded
  //    versions keeps the picker honest even if an inbox column went stale.
  const { data: docRows, error: docError } = await supabase
    .from('document_attachments')
    .select('id, file_name, mime_type, file_size_bytes, journal_entry_id, is_current_version')
    .eq('company_id', companyId)
    .in('id', docIds)
    .is('journal_entry_id', null)
    .eq('is_current_version', true)

  if (docError) {
    log.error('inbox-available document query failed', docError)
    return errorResponse(docError, log, { requestId })
  }

  const docById = new Map<string, DocRow>()
  for (const d of (docRows ?? []) as DocRow[]) docById.set(d.id, d)

  // Preserve the inbox ordering (newest first); drop items whose document is
  // gone, consumed, or superseded.
  const data = rows
    .map((row) => {
      const doc = row.document_id ? docById.get(row.document_id) : undefined
      if (!doc) return null
      const ex = row.extracted_data
      return {
        inbox_item_id: row.id,
        document_id: doc.id,
        file_name: doc.file_name,
        mime_type: doc.mime_type,
        file_size_bytes: doc.file_size_bytes,
        source: row.source,
        created_at: row.created_at,
        supplier_name: ex?.supplier?.name ?? null,
        amount: ex?.totals?.total ?? null,
        currency: ex?.invoice?.currency ?? 'SEK',
        invoice_date: ex?.invoice?.invoiceDate ?? null,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)

  return NextResponse.json({ data })
})
