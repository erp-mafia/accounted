/**
 * One document, one inbox item (crm#1413).
 *
 * Two writers file inbox items for a new document. The door it came through
 * (the MCP upload, the inbox's own upload and e-mail path) files its item
 * after it has read the document, which takes seconds to minutes. Arkiv reads
 * and classifies every new document on its own clock and queues a receipt or
 * invoice that has no item yet (invoice-inbox route-from-arkiv.ts). A document
 * Arkiv classified inside the door's reading window got Arkiv's item first and
 * then the door's own: two items for one document, the copy without the door's
 * reading and stamp ("partner_api" for an MCP upload) left in Behöver dig
 * after the other was booked (prod 2026-09-25..10-25: 35 such twins).
 *
 * The door therefore looks before it files: an item already on its document
 * is taken over, the door writing what it knows on it (its reading, its door
 * stamp, its e-mail fields) instead of inserting a second. An item that was
 * handled meanwhile (booked, matched or converted) keeps what it has, and the
 * door files nothing. A failed read or write leaves the door to file its own
 * item as before: a twin is a cosmetic fault, a lost upload is not.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLogger } from '@/lib/logger'

const log = createLogger('documents/queued-inbox-item')

/** What a door writes on the item it files, beside the document: its own insert's columns. */
export interface DoorInboxItemFields {
  status: string
  source: string
  channel_context: Record<string, unknown> | null
  extracted_data: Record<string, unknown> | null
  extraction_skipped: boolean
  matched_supplier_id: string | null
  kind_hint: string | null
  matched_transaction_id?: string | null
  email_from?: string | null
  email_subject?: string | null
  email_received_at?: string | null
  email_body_text?: string | null
  resend_email_id?: string | null
  resend_attachment_id?: string | null
  raw_email_payload?: Record<string, unknown> | null
  correlation_id?: string | null
  whatsapp_message_id?: string | null
}

export interface QueuedInboxItem {
  id: string
  status: string
  extracted_data: Record<string, unknown> | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  /** True when the door's fields landed on the item; false when it was handled already, or is the door's own. */
  adopted: boolean
}

interface ItemRow {
  id: string
  status: string
  extracted_data: Record<string, unknown> | null
  matched_supplier_id: string | null
  matched_transaction_id: string | null
  created_supplier_invoice_id: string | null
  created_journal_entry_id: string | null
  channel_context: { intake_source?: unknown } | null
}

const handled = (row: ItemRow) => !!(row.created_supplier_invoice_id || row.created_journal_entry_id || row.matched_transaction_id)

const asQueued = (row: Pick<ItemRow, 'id' | 'status' | 'extracted_data' | 'matched_supplier_id' | 'matched_transaction_id'>, adopted: boolean): QueuedInboxItem => ({
  id: row.id,
  status: row.status,
  extracted_data: row.extracted_data ?? null,
  matched_supplier_id: row.matched_supplier_id ?? null,
  matched_transaction_id: row.matched_transaction_id ?? null,
  adopted,
})

/**
 * The item already filed for `documentId`, taken over with the door's
 * fields; null when there is none (the door files its own). `ownStamp` is the
 * door's channel_context.intake_source: an item carrying it is the door's own
 * from an earlier attempt of the same upload, answered as it stands so a
 * retry never overwrites a reading a person or agent corrected since.
 */
export async function adoptQueuedInboxItem(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  fields: DoorInboxItemFields,
  options: { ownStamp?: string } = {},
): Promise<QueuedInboxItem | null> {
  try {
    return await takeOver(supabase, companyId, documentId, fields, options.ownStamp)
  } catch (err) {
    log.warn('queued inbox item takeover threw; the door files its own', { documentId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

async function takeOver(
  supabase: SupabaseClient,
  companyId: string,
  documentId: string,
  fields: DoorInboxItemFields,
  ownStamp: string | undefined,
): Promise<QueuedInboxItem | null> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, status, extracted_data, matched_supplier_id, matched_transaction_id, created_supplier_invoice_id, created_journal_entry_id, channel_context')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .order('created_at', { ascending: true })
    .limit(1)
  if (error) {
    log.warn('queued inbox item lookup failed; the door files its own', { documentId, error: error.message })
    return null
  }
  const queued = ((data ?? []) as ItemRow[])[0]
  if (!queued) return null
  if (handled(queued)) return asQueued(queued, false)
  if (ownStamp && queued.channel_context?.intake_source === ownStamp) return asQueued(queued, false)

  // Guarded on the open-item predicate, as every write that settles an item: a booking or a match that lands between
  // the read above and this write wins, and the door files nothing.
  const { data: updated, error: updateError } = await supabase
    .from('invoice_inbox_items')
    .update({
      status: fields.status,
      source: fields.source,
      channel_context: fields.channel_context,
      extracted_data: fields.extracted_data,
      extraction_skipped: fields.extraction_skipped,
      matched_supplier_id: fields.matched_supplier_id,
      kind_hint: fields.kind_hint,
      matched_transaction_id: fields.matched_transaction_id ?? null,
      email_from: fields.email_from ?? null,
      email_subject: fields.email_subject ?? null,
      email_received_at: fields.email_received_at ?? null,
      email_body_text: fields.email_body_text ?? null,
      resend_email_id: fields.resend_email_id ?? null,
      resend_attachment_id: fields.resend_attachment_id ?? null,
      raw_email_payload: fields.raw_email_payload ?? null,
      correlation_id: fields.correlation_id ?? null,
      whatsapp_message_id: fields.whatsapp_message_id ?? null,
    })
    .eq('id', queued.id)
    .eq('company_id', companyId)
    .is('created_supplier_invoice_id', null)
    .is('created_journal_entry_id', null)
    .is('matched_transaction_id', null)
    .select('id, status, extracted_data, matched_supplier_id, matched_transaction_id')
  if (updateError) {
    log.warn('queued inbox item takeover failed; the door files its own', { documentId, itemId: queued.id, error: updateError.message })
    return null
  }
  const row = ((updated ?? []) as ItemRow[])[0]
  return row ? asQueued(row, true) : asQueued(queued, false)
}
