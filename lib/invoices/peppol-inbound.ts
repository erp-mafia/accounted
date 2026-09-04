/**
 * Inbound Peppol documents: pull what the Access Point holds for us, archive
 * the exact XML, route each document to the company whose identifier it was
 * addressed to, and hand it to the supplier-invoice inbox.
 *
 * Every step is recorded on `peppol_inbound_documents`, so a crash between
 * "archived" and "in the inbox" shows up as a row in `routed`/`failed` state
 * that the next run picks up again, instead of a silently lost e-invoice.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'
import { describeError, sha256Hex } from '@/lib/invoices/peppol-delivery'
import {
  parseUblJsonDocument,
  type PeppolInboundDocument,
} from '@/lib/invoices/peppol-inbound-ubl'
import type {
  PeppolInboundDocumentType,
  PeppolInboundMessage,
  PeppolTransport,
} from '@/lib/invoices/peppol-transport'

export type PeppolInboundStatus = 'received' | 'routed' | 'unrouted' | 'converted' | 'ignored' | 'failed'

export interface PeppolInboundRow {
  id: string
  provider: string
  provider_document_id: string
  document_type: PeppolInboundDocumentType
  document_id: string | null
  issue_date: string | null
  due_date: string | null
  currency: string | null
  payable_amount: number | null
  sender_scheme: string | null
  sender_identifier: string | null
  sender_name: string | null
  recipient_scheme: string | null
  recipient_identifier: string | null
  company_id: string | null
  status: PeppolInboundStatus
  inbox_item_id: string | null
  supplier_invoice_id: string | null
  xml_document_id: string | null
  xml_payload: string | null
  xml_sha256: string | null
  ubl_json: Record<string, unknown>
  summary: Record<string, unknown>
  received_at: string
  processed_at: string | null
  last_error: string | null
}

/** What the inbox integration receives for one routed document. */
export interface PeppolInboundDelivery {
  row: PeppolInboundRow
  companyId: string
  document: PeppolInboundDocument
  xml: string | null
}

export type PeppolInboundDeliverer = (delivery: PeppolInboundDelivery) => Promise<{
  inboxItemId: string | null
  supplierInvoiceId?: string | null
  /** document_attachments id of the archived exact XML, when the deliverer archived it. */
  xmlDocumentId?: string | null
}>

export interface PeppolInboundSyncResult {
  listed: number
  archived: number
  duplicates: number
  routed: number
  unrouted: number
  delivered: number
  failed: number
  errors: Array<{ providerDocumentId: string; reason: string }>
}

function cleanIsoDate(value: string | null): string | null {
  return value && ISO_DATE_RE.test(value) ? value : null
}

function roundMoney(value: number | null): number | null {
  return value === null ? null : roundOre(value)
}

/** Company for a recipient identifier, via a live registration; null when nobody is registered. */
export async function resolvePeppolRecipientCompany(args: {
  service: SupabaseClient
  provider: string
  scheme: string
  identifier: string
}): Promise<string | null> {
  const { data, error } = await args.service
    .from('peppol_registrations')
    .select('company_id')
    .eq('provider', args.provider)
    .eq('participant_scheme', args.scheme)
    .eq('participant_identifier', args.identifier.replace(/\s/g, ''))
    .eq('status', 'registered')
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to resolve Peppol recipient: ${error.message}`)
  return (data as { company_id: string } | null)?.company_id ?? null
}

/**
 * Archive one message from the provider. Idempotent on (provider, provider
 * document id): a message seen before returns the stored row and
 * `created: false`.
 */
export async function archiveInboundPeppolMessage(args: {
  service: SupabaseClient
  transport: PeppolTransport
  message: PeppolInboundMessage
  log: Logger
}): Promise<{ row: PeppolInboundRow; document: PeppolInboundDocument | null; created: boolean }> {
  const { service, transport, message } = args

  const { data: existing, error: existingError } = await service
    .from('peppol_inbound_documents')
    .select('*')
    .eq('provider', message.provider)
    .eq('provider_document_id', message.providerDocumentId)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to read inbound Peppol archive: ${existingError.message}`)
  if (existing) {
    const row = existing as PeppolInboundRow
    return { row, document: parseUblJsonDocument(row.ubl_json), created: false }
  }

  const document = parseUblJsonDocument(message.payload)
  let xml: string | null = null
  try {
    xml = transport.fetchInboundDocumentXml
      ? await transport.fetchInboundDocumentXml(message.providerDocumentId, message.documentType)
      : null
  } catch (err) {
    // The JSON payload is already in hand; the exact XML is retried on a later
    // pass rather than blocking the archive of what we have.
    args.log.warn('inbound Peppol XML fetch failed, archiving JSON only', {
      providerDocumentId: message.providerDocumentId,
      reason: describeError(err),
    })
  }

  const recipient = document?.customer.endpoint ?? null
  const { data, error } = await service
    .from('peppol_inbound_documents')
    .insert({
    provider: message.provider,
    provider_document_id: message.providerDocumentId,
    document_type: message.documentType,
    document_id: document?.documentId || null,
    issue_date: cleanIsoDate(document?.issueDate ?? null),
    due_date: cleanIsoDate(document?.dueDate ?? null),
    currency: document?.currency && /^[A-Z]{3}$/.test(document.currency) ? document.currency : null,
    payable_amount: roundMoney(document?.totals.payable ?? null),
    sender_scheme: document?.supplier.endpoint?.scheme ?? null,
    sender_identifier: document?.supplier.endpoint?.identifier ?? null,
    sender_name: document?.supplier.name ?? null,
    recipient_scheme: recipient?.scheme ?? null,
    recipient_identifier: recipient?.identifier ?? null,
    status: 'received',
    xml_payload: xml,
    xml_sha256: xml ? sha256Hex(xml) : null,
    ubl_json: message.payload,
    summary: document ? { warnings: document.warnings, lines: document.lines.length, attachments: document.attachments.length } : { unparsed: true },
    received_at: message.receivedAt ?? new Date().toISOString(),
    })
    .select('*')
    .single()
  if (error || !data) {
    // A concurrent run may have archived it first: re-read instead of failing.
    if (error && /duplicate|unique/i.test(error.message)) {
      const { data: raced } = await service
        .from('peppol_inbound_documents')
        .select('*')
        .eq('provider', message.provider)
        .eq('provider_document_id', message.providerDocumentId)
        .maybeSingle()
      if (raced) {
        const row = raced as PeppolInboundRow
        return { row, document: parseUblJsonDocument(row.ubl_json), created: false }
      }
    }
    throw new Error(`Failed to archive inbound Peppol document: ${error?.message ?? 'no row'}`)
  }
  return { row: data as PeppolInboundRow, document, created: true }
}

async function updateRow(
  service: SupabaseClient,
  id: string,
  patch: Partial<PeppolInboundRow>,
): Promise<PeppolInboundRow> {
  const { data, error } = await service
    .from('peppol_inbound_documents')
    .update(patch)
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to update inbound Peppol document: ${error?.message ?? 'no row'}`)
  return data as PeppolInboundRow
}

/**
 * Route an archived document to its company and deliver it to the inbox.
 * Safe to call again on rows left in `received`/`routed`/`failed`.
 */
export async function processInboundPeppolRow(args: {
  service: SupabaseClient
  row: PeppolInboundRow
  document: PeppolInboundDocument | null
  deliver: PeppolInboundDeliverer | null
  log: Logger
}): Promise<{ row: PeppolInboundRow; outcome: 'delivered' | 'routed' | 'unrouted' | 'failed' | 'skipped' }> {
  const { service, log } = args
  let row = args.row
  if (row.status === 'converted' || row.status === 'ignored') return { row, outcome: 'skipped' }

  if (!row.company_id) {
    if (!row.recipient_scheme || !row.recipient_identifier) {
      row = await updateRow(service, row.id, {
        status: 'unrouted',
        last_error: 'recipient endpoint missing in document',
        processed_at: new Date().toISOString(),
      })
      return { row, outcome: 'unrouted' }
    }
    const companyId = await resolvePeppolRecipientCompany({
      service,
      provider: row.provider,
      scheme: row.recipient_scheme,
      identifier: row.recipient_identifier,
    })
    if (!companyId) {
      row = await updateRow(service, row.id, {
        status: 'unrouted',
        last_error: null,
        processed_at: new Date().toISOString(),
      })
      log.warn('inbound Peppol document for an unregistered recipient', {
        providerDocumentId: row.provider_document_id,
        recipient: `${row.recipient_scheme}:${row.recipient_identifier}`,
      })
      return { row, outcome: 'unrouted' }
    }
    row = await updateRow(service, row.id, { company_id: companyId, status: 'routed', last_error: null })
  }

  if (!args.deliver || !args.document) {
    if (!args.document) {
      row = await updateRow(service, row.id, {
        status: 'failed',
        last_error: 'document could not be read as UBL',
        processed_at: new Date().toISOString(),
      })
      return { row, outcome: 'failed' }
    }
    return { row, outcome: 'routed' }
  }

  try {
    const result = await args.deliver({
      row,
      companyId: row.company_id as string,
      document: args.document,
      xml: row.xml_payload,
    })
    row = await updateRow(service, row.id, {
      status: 'converted',
      inbox_item_id: result.inboxItemId,
      supplier_invoice_id: result.supplierInvoiceId ?? null,
      xml_document_id: result.xmlDocumentId ?? row.xml_document_id ?? null,
      processed_at: new Date().toISOString(),
      last_error: null,
    })
    return { row, outcome: 'delivered' }
  } catch (err) {
    const reason = describeError(err)
    log.error('inbound Peppol delivery to inbox failed', err as Error, { providerDocumentId: row.provider_document_id })
    row = await updateRow(service, row.id, { status: 'failed', last_error: reason })
    return { row, outcome: 'failed' }
  }
}

/**
 * One polling pass: list unread invoices and credit notes at the provider,
 * archive, route and deliver each. Errors are per document; the pass always
 * finishes.
 */
export async function syncInboundPeppolDocuments(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  limit?: number
}): Promise<PeppolInboundSyncResult> {
  const { service, transport, log } = args
  const result: PeppolInboundSyncResult = {
    listed: 0, archived: 0, duplicates: 0, routed: 0, unrouted: 0, delivered: 0, failed: 0, errors: [],
  }
  if (!transport.listInboundDocuments) return result

  for (const documentType of ['Invoice', 'CreditNote'] as const) {
    let messages: PeppolInboundMessage[] = []
    try {
      messages = await transport.listInboundDocuments({ documentType, limit: args.limit ?? 50 })
    } catch (err) {
      log.error('inbound Peppol listing failed', err as Error, { documentType })
      result.errors.push({ providerDocumentId: `list:${documentType}`, reason: describeError(err) })
      continue
    }
    result.listed += messages.length

    for (const message of messages) {
      try {
        const archived = await archiveInboundPeppolMessage({ service, transport, message, log })
        if (archived.created) result.archived += 1
        else result.duplicates += 1
        const processed = await processInboundPeppolRow({
          service,
          row: archived.row,
          document: archived.document,
          deliver: args.deliver,
          log,
        })
        if (processed.outcome === 'delivered') result.delivered += 1
        else if (processed.outcome === 'routed') result.routed += 1
        else if (processed.outcome === 'unrouted') result.unrouted += 1
        else if (processed.outcome === 'failed') result.failed += 1
      } catch (err) {
        result.failed += 1
        result.errors.push({ providerDocumentId: message.providerDocumentId, reason: describeError(err) })
        log.error('inbound Peppol document failed', err as Error, { providerDocumentId: message.providerDocumentId })
      }
    }
  }

  return result
}
