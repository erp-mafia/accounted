/**
 * Inbound Peppol documents: pull what the Access Point holds for us, archive
 * the exact XML, route each document to the company whose identifier it was
 * addressed to, and hand it to the supplier-invoice inbox.
 *
 * Every step is recorded on `peppol_inbound_documents`, so a crash between
 * "archived" and "in the inbox" shows up as a row in `routed`/`failed` state
 * that is picked up again, instead of a silently lost e-invoice. Two passes
 * do the picking up: the listing sync (what the provider lists right now,
 * healed on sight) and the reprocessing pass (what the archive holds in a
 * pending state, independent of the provider's listing window).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { ISO_DATE_RE } from '@/lib/invariants'
import { roundOre } from '@/lib/money'
import { describeError, sha256Hex } from '@/lib/invoices/peppol-delivery'
import { normalizePeppolIdentifier } from '@/lib/invoices/peppol-identifiers'
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

/**
 * `last_error` markers with a meaning for the retry machinery. A `terminal:`
 * prefix means no pass will touch the row again without a human: retrying
 * cannot change the answer.
 */
export const PEPPOL_INBOUND_TERMINAL_PREFIX = 'terminal:'
export const PEPPOL_INBOUND_XML_UNAVAILABLE = 'terminal: xml unavailable upstream'
/** The row is routed but held back from the inbox until the exact XML is archived. */
export const PEPPOL_INBOUND_AWAITING_XML = 'awaiting xml'

export function isTerminalInboundError(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && lastError.startsWith(PEPPOL_INBOUND_TERMINAL_PREFIX)
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
  /**
   * Set when the deliverer declined to file the document yet (no inbox item
   * was created): the row stays `routed` with this as its `last_error` and a
   * later pass delivers it. `inboxItemId` is null when this is set.
   */
  holdReason?: string | null
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

export interface PeppolInboundReprocessResult {
  /** Pending rows examined this pass (bounded by `limit`). */
  candidates: number
  /** Rows whose missing XML was fetched and archived this pass. */
  xmlFetched: number
  /** Rows that gained a company this pass (a registration appeared). */
  routed: number
  /** Rows filed in the inbox this pass. */
  delivered: number
  /** Rows marked or found terminal this pass; nothing more will be tried on them. */
  terminal: number
  /** Retryable problems: the row keeps its state and is examined again after the backoff. */
  errors: Array<{ id: string; providerDocumentId: string; reason: string }>
}

/** How long a pending row rests between two reprocessing attempts. */
export const PEPPOL_INBOUND_REPROCESS_BACKOFF_MS = 30 * 60 * 1000

function cleanIsoDate(value: string | null): string | null {
  return value && ISO_DATE_RE.test(value) ? value : null
}

function roundMoney(value: number | null): number | null {
  return value === null ? null : roundOre(value)
}

/**
 * Company for a recipient identifier, via a live registration; null when
 * nobody is registered. Both sides are compared in normalised form
 * (lib/invoices/peppol-identifiers.ts): a hyphenated or 16-prefixed
 * EndpointID routes to the digits-only registration, and a registration
 * stored with formatting still matches a clean endpoint.
 */
export async function resolvePeppolRecipientCompany(args: {
  service: SupabaseClient
  provider: string
  scheme: string
  identifier: string
}): Promise<string | null> {
  const wanted = normalizePeppolIdentifier(args.scheme, args.identifier)
  if (!wanted) return null
  const { data, error } = await args.service
    .from('peppol_registrations')
    .select('company_id, participant_identifier')
    .eq('provider', args.provider)
    .eq('participant_scheme', args.scheme)
    .eq('status', 'registered')
  if (error) throw new Error(`Failed to resolve Peppol recipient: ${error.message}`)
  const registrations = (data ?? []) as Array<{ company_id: string; participant_identifier: string }>
  const match = registrations.find(
    (registration) => normalizePeppolIdentifier(args.scheme, registration.participant_identifier) === wanted,
  )
  return match?.company_id ?? null
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
 * Fetch and archive the exact XML for a row that has none. The one place the
 * XML retry lives: the listing sync calls it for a document it sees again,
 * the reprocessing pass for anything pending.
 *
 * - a document comes back: stored with its hash (the immutability trigger
 *   allows null -> value once);
 * - the provider answers null: the XML does not exist upstream, so the row
 *   is marked terminal and never asked for again;
 * - the transport fails: nothing is written, the row stays retryable.
 */
export async function fetchMissingInboundXml(args: {
  service: SupabaseClient
  transport: PeppolTransport
  row: PeppolInboundRow
  log: Logger
  now?: Date
}): Promise<{ row: PeppolInboundRow; outcome: 'fetched' | 'terminal' | 'error' | 'skipped'; reason?: string }> {
  const { service, transport, row, log } = args
  if (row.xml_payload || !transport.fetchInboundDocumentXml || isTerminalInboundError(row.last_error)) {
    return { row, outcome: 'skipped' }
  }
  const touchedAt = (args.now ?? new Date()).toISOString()
  let xml: string | null
  try {
    xml = await transport.fetchInboundDocumentXml(row.provider_document_id, row.document_type)
  } catch (err) {
    const reason = describeError(err)
    log.warn('inbound Peppol XML fetch failed, will retry', { providerDocumentId: row.provider_document_id, reason })
    return { row, outcome: 'error', reason }
  }
  if (!xml) {
    const updated = await updateRow(service, row.id, {
      last_error: PEPPOL_INBOUND_XML_UNAVAILABLE,
      processed_at: touchedAt,
    })
    log.warn('inbound Peppol XML unavailable upstream, document kept as JSON only', {
      providerDocumentId: row.provider_document_id,
    })
    return { row: updated, outcome: 'terminal' }
  }
  const updated = await updateRow(service, row.id, {
    xml_payload: xml,
    xml_sha256: sha256Hex(xml),
    processed_at: touchedAt,
  })
  return { row: updated, outcome: 'fetched' }
}

/**
 * Archive one message from the provider. Idempotent on (provider, provider
 * document id): a message seen before returns the stored row and
 * `created: false`, after fetching its XML if the archive still lacks it.
 */
export async function archiveInboundPeppolMessage(args: {
  service: SupabaseClient
  transport: PeppolTransport
  message: PeppolInboundMessage
  log: Logger
}): Promise<{ row: PeppolInboundRow; document: PeppolInboundDocument | null; created: boolean }> {
  const { service, transport, message, log } = args

  const { data: existing, error: existingError } = await service
    .from('peppol_inbound_documents')
    .select('*')
    .eq('provider', message.provider)
    .eq('provider_document_id', message.providerDocumentId)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to read inbound Peppol archive: ${existingError.message}`)
  if (existing) {
    // Seen is not done: a row archived as JSON only gets its XML on sight.
    const { row } = await fetchMissingInboundXml({ service, transport, row: existing as PeppolInboundRow, log })
    return { row, document: parseUblJsonDocument(row.ubl_json), created: false }
  }

  const document = parseUblJsonDocument(message.payload)
  let xml: string | null = null
  try {
    xml = transport.fetchInboundDocumentXml
      ? await transport.fetchInboundDocumentXml(message.providerDocumentId, message.documentType)
      : null
  } catch (err) {
    // The JSON payload is already in hand; the exact XML is fetched again by
    // the reprocessing pass rather than blocking the archive of what we have.
    log.warn('inbound Peppol XML fetch failed, archiving JSON only', {
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

/**
 * Route an archived document to its company and deliver it to the inbox.
 * Safe to call again on rows left in `received`/`routed`/`unrouted`/`failed`;
 * `converted`, `ignored` and terminal rows are left alone.
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
  if (row.status === 'converted' || row.status === 'ignored' || isTerminalInboundError(row.last_error)) {
    return { row, outcome: 'skipped' }
  }

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
    if (result.holdReason) {
      // Not filed yet (typically: the exact XML is not archived). The row
      // stays routed and the reprocessing pass tries again after the backoff.
      row = await updateRow(service, row.id, {
        status: 'routed',
        last_error: result.holdReason,
        processed_at: new Date().toISOString(),
      })
      return { row, outcome: 'routed' }
    }
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
    row = await updateRow(service, row.id, {
      status: 'failed',
      last_error: reason,
      processed_at: new Date().toISOString(),
    })
    return { row, outcome: 'failed' }
  }
}

/**
 * The newest `received_at` archived for one provider and document type: the
 * listing cursor. Null when the archive holds nothing for the pair yet.
 */
async function newestArchivedReceivedAt(
  service: SupabaseClient,
  provider: string,
  documentType: PeppolInboundDocumentType,
): Promise<string | null> {
  const { data, error } = await service
    .from('peppol_inbound_documents')
    .select('received_at')
    .eq('provider', provider)
    .eq('document_type', documentType)
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) throw new Error(`Failed to read inbound Peppol cursor: ${error.message}`)
  return (data as { received_at: string } | null)?.received_at ?? null
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
      // The cursor lets a provider that supports it skip what we already
      // hold; the archive's unique key dedupes for one that does not.
      const receivedAfter = await newestArchivedReceivedAt(service, transport.provider, documentType)
      messages = await transport.listInboundDocuments({
        documentType,
        limit: args.limit ?? 50,
        ...(receivedAfter ? { receivedAfter } : {}),
      })
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

/**
 * Reprocessing pass over the archive, independent of what the provider
 * lists: every row still pending (`received`, `routed`, `unrouted`, `failed`)
 * that has rested for the backoff is examined again, least recently
 * processed first, terminal rows excluded. For each: the missing XML is
 * fetched, routing is re-run (a registration that appeared since routes a
 * previously unrouted document) and the inbox delivery is attempted.
 *
 * Every candidate is stamped `processed_at = now` before anything else, so a
 * row is never examined twice within one backoff whatever happens to it.
 */
export async function reprocessInboundPeppolDocuments(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  limit?: number
  now?: Date
}): Promise<PeppolInboundReprocessResult> {
  const { service, transport, log } = args
  const limit = args.limit ?? 25
  const now = args.now ?? new Date()
  const cutoff = new Date(now.getTime() - PEPPOL_INBOUND_REPROCESS_BACKOFF_MS).toISOString()
  const result: PeppolInboundReprocessResult = {
    candidates: 0, xmlFetched: 0, routed: 0, delivered: 0, terminal: 0, errors: [],
  }

  const { data, error } = await service
    .from('peppol_inbound_documents')
    .select('*')
    .eq('provider', transport.provider)
    .in('status', ['received', 'routed', 'unrouted', 'failed'])
    .or(`processed_at.is.null,processed_at.lt.${cutoff}`)
    .or(`last_error.is.null,last_error.not.like.${PEPPOL_INBOUND_TERMINAL_PREFIX}*`)
    .order('processed_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) throw new Error(`Failed to list pending inbound Peppol documents: ${error.message}`)
  const candidates = (data ?? []) as PeppolInboundRow[]
  result.candidates = candidates.length

  for (const candidate of candidates) {
    if (isTerminalInboundError(candidate.last_error)) {
      result.terminal += 1
      continue
    }
    try {
      let row = await updateRow(service, candidate.id, { processed_at: now.toISOString() })
      const hadCompany = !!row.company_id

      const xml = await fetchMissingInboundXml({ service, transport, row, log, now })
      row = xml.row
      if (xml.outcome === 'fetched') result.xmlFetched += 1
      if (xml.outcome === 'terminal') {
        result.terminal += 1
        continue
      }
      if (xml.outcome === 'error') {
        result.errors.push({ id: row.id, providerDocumentId: row.provider_document_id, reason: xml.reason ?? 'xml fetch failed' })
      }

      const processed = await processInboundPeppolRow({
        service,
        row,
        document: parseUblJsonDocument(row.ubl_json),
        deliver: args.deliver,
        log,
      })
      if (!hadCompany && processed.row.company_id) result.routed += 1
      if (processed.outcome === 'delivered') result.delivered += 1
      else if (processed.outcome === 'failed') {
        result.errors.push({
          id: row.id,
          providerDocumentId: row.provider_document_id,
          reason: processed.row.last_error ?? 'processing failed',
        })
      }
    } catch (err) {
      result.errors.push({ id: candidate.id, providerDocumentId: candidate.provider_document_id, reason: describeError(err) })
      log.error('inbound Peppol reprocessing failed for a document', err as Error, {
        id: candidate.id,
        providerDocumentId: candidate.provider_document_id,
      })
    }
  }

  return result
}
