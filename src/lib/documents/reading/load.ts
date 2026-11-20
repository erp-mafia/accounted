import type { SupabaseClient } from '@supabase/supabase-js'
import type { PeppolInboundDocument } from '@/lib/invoices/peppol-inbound-ubl'
import type { InvoiceExtractionResult } from '@/types'
import type { ArkivRecord, SupplierCard } from './assemble'
import { resolveDocumentReading, type ReadingDocumentRow, type ReadingItemRow } from './resolve'
import type { DocumentReading } from './types'

/**
 * Load what is stored about a document and its inbox item, and resolve it
 * into one DocumentReading (./resolve.ts). Reads only, every query scoped to
 * the company explicitly (service-role callers have no RLS).
 *
 *   1. the inbox item: passed in by a caller that already read it, else the
 *      newest item carrying the document;
 *   2. the document row, all columns: a deploy that reaches this code before
 *      the model_reading migration must not fail the read (the suggestion
 *      log reads it the same way, lib/suggestion-log/inbox.ts);
 *   3. at once: the Peppol archive row of a Peppol item (its UBL-JSON, the
 *      Access Point's rendering of the exact XML), the document's current
 *      Arkiv record, and the matched supplier's card.
 *
 * Throws on a failed query: callers that return the reading on their own
 * read decide whether a failure fails the read.
 */
export type ReadingTarget = { item: ReadingItemRow } | { documentId: string }

/**
 * The Peppol side of the reading: parse the archive row's UBL-JSON and map
 * it as the delivery does. The invoicing block owns both
 * (lib/invoices/peppol-reading.ts) and this block may not import it, so the
 * caller passes it in; without it a Peppol item is read without its xml
 * source.
 */
export interface PeppolReader {
  parse: (ublJson: unknown) => PeppolInboundDocument | null
  toExtraction: (document: PeppolInboundDocument) => InvoiceExtractionResult
}

/** loadDocumentReading with its Peppol reader bound, for a caller that hands the read on. */
export type DocumentReadingLoader = (supabase: SupabaseClient, companyId: string, target: ReadingTarget) => Promise<DocumentReading>

function fail(what: string, error: { message: string }): never {
  throw new Error(`document reading: ${what} failed: ${error.message}`)
}

async function itemForDocument(supabase: SupabaseClient, companyId: string, documentId: string): Promise<ReadingItemRow | null> {
  const { data, error } = await supabase
    .from('invoice_inbox_items')
    .select('id, document_id, source, extracted_data, extraction_skipped, kind_hint, channel_context, email_from, email_received_at, matched_supplier_id')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) fail('inbox item read', error)
  return (data as ReadingItemRow | null) ?? null
}

async function loadDocument(supabase: SupabaseClient, companyId: string, documentId: string): Promise<ReadingDocumentRow | null> {
  const { data, error } = await supabase.from('document_attachments').select('*').eq('id', documentId).eq('company_id', companyId).maybeSingle()
  if (error) fail('document read', error)
  return (data as ReadingDocumentRow | null) ?? null
}

function isPeppolItem(item: ReadingItemRow | null): boolean {
  return item?.source === 'peppol' || item?.channel_context?.channel === 'peppol'
}

async function loadPeppol(supabase: SupabaseClient, companyId: string, item: ReadingItemRow, reader: PeppolReader): Promise<PeppolInboundDocument | null> {
  const context = item.channel_context ?? null
  const provider = context?.peppol_provider ?? null
  const providerDocumentId = context?.peppol_document_id ?? null
  // The provider's id is what the delivery files the item under; the back-link is set once the delivery returned.
  const { data, error } =
    provider && providerDocumentId
      ? await supabase
          .from('peppol_inbound_documents')
          .select('ubl_json')
          .eq('company_id', companyId)
          .eq('provider', provider)
          .eq('provider_document_id', providerDocumentId)
          .maybeSingle()
      : await supabase.from('peppol_inbound_documents').select('ubl_json').eq('company_id', companyId).eq('inbox_item_id', item.id).maybeSingle()
  if (error) fail('Peppol archive read', error)
  const ubl = (data as { ubl_json?: unknown } | null)?.ubl_json
  return ubl ? reader.parse(ubl) : null
}

async function loadArkivRecord(supabase: SupabaseClient, companyId: string, documentId: string): Promise<ArkivRecord | null> {
  const { data, error } = await supabase
    .from('document_extractions')
    .select('schema_type, payload')
    .eq('company_id', companyId)
    .eq('document_id', documentId)
    .eq('is_current', true)
    .maybeSingle()
  if (error) fail('Arkiv record read', error)
  const row = data as { schema_type?: unknown; payload?: unknown } | null
  if (!row || typeof row.schema_type !== 'string' || typeof row.payload !== 'object' || row.payload === null) return null
  return { schema_type: row.schema_type, payload: row.payload as ArkivRecord['payload'] }
}

async function loadSupplier(supabase: SupabaseClient, companyId: string, supplierId: string): Promise<SupplierCard | null> {
  const { data, error } = await supabase
    .from('suppliers')
    .select('name, org_number, vat_number, bankgiro, plusgiro, iban')
    .eq('id', supplierId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) fail('supplier read', error)
  return (data as SupplierCard | null) ?? null
}

export async function loadDocumentReading(
  supabase: SupabaseClient,
  companyId: string,
  target: ReadingTarget,
  peppolReader?: PeppolReader,
): Promise<DocumentReading> {
  const item = 'item' in target ? target.item : await itemForDocument(supabase, companyId, target.documentId)
  const documentId = 'item' in target ? (target.item.document_id ?? null) : target.documentId
  const document = documentId ? await loadDocument(supabase, companyId, documentId) : null
  const [peppol, arkiv, supplier] = await Promise.all([
    item && peppolReader && isPeppolItem(item) ? loadPeppol(supabase, companyId, item, peppolReader) : null,
    document ? loadArkivRecord(supabase, companyId, document.id) : null,
    item?.matched_supplier_id ? loadSupplier(supabase, companyId, item.matched_supplier_id) : null,
  ])
  return resolveDocumentReading({ item, document, peppol, arkiv, supplier, peppolToExtraction: peppolReader?.toExtraction })
}
