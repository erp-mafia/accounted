import type { SupabaseClient } from '@supabase/supabase-js'
import type { InvoiceExtractionResult } from '@/types'
import { whereInboxItemOpen } from './inbox-item-state'

/**
 * An inbox document that can be attached as underlag to a verifikat: the
 * inbox item is open (no supplier invoice, no verifikat, no bank row, not in
 * Arkiv), it has a file, and that file is the current version and on no
 * verifikat yet. Re-pointing a linked document is forbidden (BFL 7 kap), so
 * those are left out and the DB immutability trigger is the backstop.
 */
export interface AvailableInboxDoc {
  inbox_item_id: string
  document_id: string
  file_name: string
  mime_type: string | null
  file_size_bytes: number
  source: string | null
  created_at: string
  supplier_name: string | null
  amount: number | null
  currency: string | null
  invoice_date: string | null
}

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
}

export type AvailableInboxDocsRead =
  | { data: AvailableInboxDoc[]; error: null }
  | { data: null; error: unknown; stage: 'items' | 'documents' }

/**
 * The newest 100 available inbox documents (GET /api/documents/inbox-available,
 * InboxDocumentPicker), or the one inbox item `inboxItemId` names when it is
 * available (the booking screen's found receipt). `invoice_inbox_items` is a
 * core table: without the invoice-inbox extension it is empty and this reads
 * nothing.
 */
export async function readAvailableInboxDocs(
  supabase: SupabaseClient,
  companyId: string,
  options: { inboxItemId?: string } = {},
): Promise<AvailableInboxDocsRead> {
  let items = whereInboxItemOpen(
    supabase
      .from('invoice_inbox_items')
      .select('id, document_id, source, created_at, extracted_data')
      .eq('company_id', companyId)
      .not('document_id', 'is', null),
  )
  if (options.inboxItemId) items = items.eq('id', options.inboxItemId)
  const { data: inboxRows, error: inboxError } = await items.order('created_at', { ascending: false }).limit(100)
  if (inboxError) return { data: null, error: inboxError, stage: 'items' }

  const rows = (inboxRows ?? []) as InboxRow[]
  const docIds = rows.map((r) => r.document_id).filter((id): id is string => !!id)
  if (docIds.length === 0) return { data: [], error: null }

  const { data: docRows, error: docError } = await supabase
    .from('document_attachments')
    .select('id, file_name, mime_type, file_size_bytes, journal_entry_id, is_current_version')
    .eq('company_id', companyId)
    .in('id', docIds)
    .is('journal_entry_id', null)
    .eq('is_current_version', true)
  if (docError) return { data: null, error: docError, stage: 'documents' }

  const docById = new Map<string, DocRow>()
  for (const d of (docRows ?? []) as DocRow[]) docById.set(d.id, d)

  const data = rows
    .map((row): AvailableInboxDoc | null => {
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
    .filter((x): x is AvailableInboxDoc => x !== null)
  return { data, error: null }
}
