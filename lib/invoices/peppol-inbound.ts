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
import { fetchAllRows } from '@/lib/supabase/fetch-all'
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
 * cannot change the answer. Every newly terminal document is paged once by
 * the cron, because a received e-invoice that cannot be archived or filed
 * is an operator matter under the seven-year retention.
 */
export const PEPPOL_INBOUND_TERMINAL_PREFIX = 'terminal:'
/** How many times the provider may answer "no XML" before the row goes terminal. */
export const PEPPOL_INBOUND_XML_MAX_MISSES = 3
export const PEPPOL_INBOUND_XML_UNAVAILABLE = `terminal: xml unavailable upstream after ${PEPPOL_INBOUND_XML_MAX_MISSES} attempts`
export const PEPPOL_INBOUND_RECIPIENT_MISSING = 'terminal: recipient endpoint missing in document'
export const PEPPOL_INBOUND_UNREADABLE = 'terminal: document could not be read as UBL'
export const PEPPOL_INBOUND_UNARCHIVABLE_PREFIX = 'terminal: payload unarchivable: '
/** The row is routed but held back from the inbox until the exact XML is archived. */
export const PEPPOL_INBOUND_AWAITING_XML = 'awaiting xml'
/** The row is routed but the company has no member to own the inbox item yet (configuration, not a fault). */
export const PEPPOL_INBOUND_AWAITING_OWNER = 'awaiting owner member'

const XML_MISS_RE = /^xml unavailable upstream \(miss (\d+)\/\d+\)$/

export function isTerminalInboundError(lastError: string | null | undefined): boolean {
  return typeof lastError === 'string' && lastError.startsWith(PEPPOL_INBOUND_TERMINAL_PREFIX)
}

/** Misses recorded so far in a `last_error` written by fetchMissingInboundXml, else 0. */
export function xmlMissCount(lastError: string | null | undefined): number {
  const match = typeof lastError === 'string' ? XML_MISS_RE.exec(lastError) : null
  return match ? Number(match[1]) : 0
}

export function xmlMissMarker(misses: number): string {
  return `xml unavailable upstream (miss ${misses}/${PEPPOL_INBOUND_XML_MAX_MISSES})`
}

/** The miss counter survives routing and holding; anything else is replaced. */
function carriedXmlMarker(row: PeppolInboundRow): string | null {
  return xmlMissCount(row.last_error) > 0 ? row.last_error : null
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

/** A document that went terminal in this run: the cron pages these once. */
export interface PeppolInboundTerminalDocument {
  id: string
  providerDocumentId: string
  reason: string
}

export interface PeppolInboundSyncResult {
  listed: number
  archived: number
  duplicates: number
  routed: number
  unrouted: number
  delivered: number
  failed: number
  /** Documents that became terminal in this run (unarchivable payloads, unreadable documents). */
  terminal: number
  terminalDocuments: PeppolInboundTerminalDocument[]
  errors: Array<{ providerDocumentId: string; reason: string }>
}

export interface PeppolInboundReprocessResult {
  /** Pending rows examined this pass (bounded by `limit`). */
  candidates: number
  /** Rows whose missing XML was fetched and archived this pass. */
  xmlFetched: number
  /** Rows the provider answered "no XML" for this pass, still under the miss budget. */
  xmlMissed: number
  /** Rows whose XML fetch hit a transport error; nothing changed, asked again after the backoff. */
  retried: number
  /** Rows routed but held back from the inbox (awaiting XML or an owner member). */
  held: number
  /** Rows that gained a company this pass (a registration appeared). */
  routed: number
  /** Rows filed in the inbox this pass. */
  delivered: number
  /** Rows that became terminal this pass; nothing more will be tried on them. */
  terminal: number
  terminalDocuments: PeppolInboundTerminalDocument[]
  /** Real failures (database, delivery): the row keeps its state, is examined again after the backoff, and the cron pages. */
  errors: Array<{ id: string; providerDocumentId: string; reason: string }>
}

/** How long a pending row rests between two attempts, in either pass. */
export const PEPPOL_INBOUND_REPROCESS_BACKOFF_MS = 30 * 60 * 1000

/**
 * Postgres codes for an insert that will fail the same way every time it is
 * retried with the same payload: a CHECK or NOT NULL violation, a value the
 * column type cannot hold. Anything else (connection, lock, RLS) may pass
 * next time.
 */
const DETERMINISTIC_PG_CODES = new Set(['23502', '23514', '22001', '22003', '22007', '22008', '22P02'])

export class PeppolInboundArchiveError extends Error {
  readonly code: string | null
  readonly deterministic: boolean
  constructor(message: string, options: { code?: string | null; cause?: unknown }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'PeppolInboundArchiveError'
    this.code = options.code ?? null
    this.deterministic = !!options.code && DETERMINISTIC_PG_CODES.has(options.code)
  }
}

function cleanIsoDate(value: string | null): string | null {
  return value && ISO_DATE_RE.test(value) ? value : null
}

function roundMoney(value: number | null): number | null {
  return value === null ? null : roundOre(value)
}

function isRested(row: PeppolInboundRow, now: Date): boolean {
  if (!row.processed_at) return true
  const processedAt = Date.parse(row.processed_at)
  return Number.isNaN(processedAt) || processedAt < now.getTime() - PEPPOL_INBOUND_REPROCESS_BACKOFF_MS
}

/** Milliseconds for an ISO timestamp, or null when it does not parse. */
function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
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

  // Registrations are written digits-only (the registration flow builds the
  // identifier from the organisation number), so the exact match is the
  // common path: one indexed read against the live-participant index.
  const { data: exact, error: exactError } = await args.service
    .from('peppol_registrations')
    .select('company_id')
    .eq('provider', args.provider)
    .eq('participant_scheme', args.scheme)
    .eq('participant_identifier', wanted)
    .eq('status', 'registered')
    .limit(1)
    .maybeSingle()
  if (exactError) throw new Error(`Failed to resolve Peppol recipient: ${exactError.message}`)
  const exactCompany = (exact as { company_id: string } | null)?.company_id
  if (exactCompany) return exactCompany

  // Fallback for a registration stored with formatting (rows written before
  // identifiers were normalised): compare in code on the normalised form,
  // paginated so PostgREST's silent 1000-row cap cannot hide the match.
  const registrations = await fetchAllRows<{ id: string; company_id: string; participant_identifier: string }>(
    ({ from, to }) =>
      args.service
        .from('peppol_registrations')
        .select('id, company_id, participant_identifier')
        .eq('provider', args.provider)
        .eq('participant_scheme', args.scheme)
        .eq('status', 'registered')
        .order('id', { ascending: true })
        .range(from, to),
    { dedupeBy: (registration) => registration.id },
  )
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
 * the reprocessing pass for anything pending. Every attempt stamps
 * `processed_at`, so neither pass asks again before the backoff.
 *
 * - a document comes back: stored with its hash (the immutability trigger
 *   allows null -> value once) and the miss counter is cleared;
 * - the provider answers null: one miss is recorded; on the third the row
 *   goes terminal and is never asked for again;
 * - the transport fails: only the attempt is stamped, the row stays as it was.
 */
export async function fetchMissingInboundXml(args: {
  service: SupabaseClient
  transport: PeppolTransport
  row: PeppolInboundRow
  log: Logger
  now?: Date
}): Promise<{ row: PeppolInboundRow; outcome: 'fetched' | 'missed' | 'terminal' | 'error' | 'skipped'; reason?: string }> {
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
    log.warn('inbound Peppol XML fetch failed, will retry after the backoff', { id: row.id, providerDocumentId: row.provider_document_id, reason })
    const updated = await updateRow(service, row.id, { processed_at: touchedAt })
    return { row: updated, outcome: 'error', reason }
  }
  if (!xml) {
    const misses = xmlMissCount(row.last_error) + 1
    if (misses >= PEPPOL_INBOUND_XML_MAX_MISSES) {
      const updated = await updateRow(service, row.id, {
        last_error: PEPPOL_INBOUND_XML_UNAVAILABLE,
        processed_at: touchedAt,
      })
      log.warn('inbound Peppol XML unavailable upstream, document is terminal', {
        providerDocumentId: row.provider_document_id,
        misses,
      })
      return { row: updated, outcome: 'terminal' }
    }
    const updated = await updateRow(service, row.id, {
      last_error: xmlMissMarker(misses),
      processed_at: touchedAt,
    })
    log.warn('inbound Peppol XML not available upstream yet, will ask again after the backoff', {
      providerDocumentId: row.provider_document_id,
      misses,
      maxMisses: PEPPOL_INBOUND_XML_MAX_MISSES,
    })
    return { row: updated, outcome: 'missed' }
  }
  const updated = await updateRow(service, row.id, {
    xml_payload: xml,
    xml_sha256: sha256Hex(xml),
    last_error: xmlMissCount(row.last_error) > 0 ? null : row.last_error,
    processed_at: touchedAt,
  })
  return { row: updated, outcome: 'fetched' }
}

/**
 * Archive one message from the provider. Idempotent on (provider, provider
 * document id): a message seen before returns the stored row and
 * `created: false`, after fetching its XML if the archive still lacks it
 * and the row has rested for the backoff (a provider that re-lists the same
 * window every run must not make each run spend a fetch timeout per row).
 *
 * An insert that fails deterministically (the payload violates a column
 * constraint) throws a PeppolInboundArchiveError with `deterministic: true`;
 * the caller decides whether to record a stub.
 */
export async function archiveInboundPeppolMessage(args: {
  service: SupabaseClient
  transport: PeppolTransport
  message: PeppolInboundMessage
  log: Logger
  now?: Date
}): Promise<{ row: PeppolInboundRow; document: PeppolInboundDocument | null; created: boolean }> {
  const { service, transport, message, log } = args
  const now = args.now ?? new Date()

  const { data: existing, error: existingError } = await service
    .from('peppol_inbound_documents')
    .select('*')
    .eq('provider', message.provider)
    .eq('provider_document_id', message.providerDocumentId)
    .maybeSingle()
  if (existingError) throw new Error(`Failed to read inbound Peppol archive: ${existingError.message}`)
  if (existing) {
    // Seen is not done: a row archived as JSON only gets its XML on sight,
    // once per backoff.
    let row = existing as PeppolInboundRow
    if (!row.xml_payload && isRested(row, now)) {
      row = (await fetchMissingInboundXml({ service, transport, row, log, now })).row
    }
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
    received_at: message.receivedAt ?? now.toISOString(),
    // Archiving is the first touch: every pending row carries a processed_at
    // from birth, so the reprocessing pass can select on a plain comparison.
    processed_at: now.toISOString(),
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
    throw new PeppolInboundArchiveError(
      `Failed to archive inbound Peppol document: ${error?.message ?? 'no row'}`,
      { code: (error as { code?: string } | null)?.code ?? null, cause: error },
    )
  }
  return { row: data as PeppolInboundRow, document, created: true }
}

/**
 * Record a document whose payload the archive cannot hold (a deterministic
 * insert failure) as a terminal stub under its own provider id, so the
 * listing cursor can move past it and the failure is paged once instead of
 * blocking every later document forever. The provider still holds the
 * original; the stub carries the reason for the operator.
 */
export async function archiveUnarchivableInboundMessage(args: {
  service: SupabaseClient
  message: PeppolInboundMessage
  reason: string
  now?: Date
}): Promise<PeppolInboundRow> {
  const { service, message } = args
  const now = args.now ?? new Date()
  const receivedAt = parseTimestamp(message.receivedAt)
  const lastError = `${PEPPOL_INBOUND_UNARCHIVABLE_PREFIX}${args.reason.slice(0, 200)}`
  const { data, error } = await service
    .from('peppol_inbound_documents')
    .insert({
      provider: message.provider,
      provider_document_id: message.providerDocumentId,
      document_type: message.documentType,
      status: 'failed',
      ubl_json: {},
      summary: { unarchivable: true },
      received_at: receivedAt === null ? now.toISOString() : new Date(receivedAt).toISOString(),
      processed_at: now.toISOString(),
      last_error: lastError,
    })
    .select('*')
    .single()
  if (error || !data) throw new Error(`Failed to record unarchivable inbound Peppol document: ${error?.message ?? 'no row'}`)
  return data as PeppolInboundRow
}

/**
 * Route an archived document to its company and deliver it to the inbox.
 * Safe to call again on rows left in `received`/`routed`/`unrouted`/`failed`;
 * `converted`, `ignored` and terminal rows are left alone. A document that
 * cannot be read, or names no recipient, is terminal: no retry can change
 * what the payload says.
 */
export async function processInboundPeppolRow(args: {
  service: SupabaseClient
  row: PeppolInboundRow
  document: PeppolInboundDocument | null
  deliver: PeppolInboundDeliverer | null
  log: Logger
}): Promise<{ row: PeppolInboundRow; outcome: 'delivered' | 'routed' | 'unrouted' | 'failed' | 'terminal' | 'skipped' }> {
  const { service, log } = args
  let row = args.row
  if (row.status === 'converted' || row.status === 'ignored' || isTerminalInboundError(row.last_error)) {
    return { row, outcome: 'skipped' }
  }

  if (!args.document) {
    row = await updateRow(service, row.id, {
      status: 'failed',
      last_error: PEPPOL_INBOUND_UNREADABLE,
      processed_at: new Date().toISOString(),
    })
    return { row, outcome: 'terminal' }
  }

  if (!row.company_id) {
    if (!row.recipient_scheme || !row.recipient_identifier) {
      row = await updateRow(service, row.id, {
        status: 'unrouted',
        last_error: PEPPOL_INBOUND_RECIPIENT_MISSING,
        processed_at: new Date().toISOString(),
      })
      return { row, outcome: 'terminal' }
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
        last_error: carriedXmlMarker(row),
        processed_at: new Date().toISOString(),
      })
      log.warn('inbound Peppol document for an unregistered recipient', {
        providerDocumentId: row.provider_document_id,
        recipient: `${row.recipient_scheme}:${row.recipient_identifier}`,
      })
      return { row, outcome: 'unrouted' }
    }
    row = await updateRow(service, row.id, { company_id: companyId, status: 'routed', last_error: carriedXmlMarker(row) })
  }

  if (!args.deliver) return { row, outcome: 'routed' }

  try {
    const result = await args.deliver({
      row,
      companyId: row.company_id as string,
      document: args.document,
      xml: row.xml_payload,
    })
    if (result.holdReason) {
      // Not filed yet (the exact XML is not archived, or nobody can own the
      // item). The row stays routed and the reprocessing pass tries again
      // after the backoff. Warned, not paged: a hold is a state, not a fault.
      row = await updateRow(service, row.id, {
        status: 'routed',
        last_error: carriedXmlMarker(row) ?? result.holdReason,
        processed_at: new Date().toISOString(),
      })
      log.warn('inbound Peppol document held back from the inbox', {
        id: row.id,
        providerDocumentId: row.provider_document_id,
        reason: result.holdReason,
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
 * The listing cursor: one second before the newest `received_at` archived
 * for one provider and document type. The second is deliberate: two
 * documents received within the same second may be listed across two runs,
 * and a cursor equal to the newest archived timestamp would let a provider
 * that honours it skip the sibling; the archive's unique key absorbs the
 * one-second overlap as a duplicate. Null when the archive holds nothing.
 */
async function listingCursor(
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
  const newest = parseTimestamp((data as { received_at: string } | null)?.received_at)
  return newest === null ? null : new Date(newest - 1000).toISOString()
}

/**
 * Oldest first, stable, unparsable or missing timestamps last: the order in
 * which the archive must fill so the newest archived `received_at` is
 * always a contiguous prefix of what the provider holds.
 */
export function orderInboundMessagesOldestFirst(messages: PeppolInboundMessage[]): PeppolInboundMessage[] {
  return messages
    .map((message, index) => ({ message, index, at: parseTimestamp(message.receivedAt) ?? Number.POSITIVE_INFINITY }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at))
    .map((entry) => entry.message)
}

/**
 * One polling pass: list unread invoices and credit notes at the provider,
 * archive, route and deliver each, oldest first. Processing errors are per
 * document; an archive failure stops the document type for this run, because
 * archiving a newer document past an older one that is not in the archive
 * would move the listing cursor beyond it (the provider re-lists the rest
 * next run; the archive's unique key tolerates the repeat). A payload the
 * archive can never hold is recorded as a terminal stub instead, so it does
 * not block the cursor forever.
 */
export async function syncInboundPeppolDocuments(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  limit?: number
  now?: Date
}): Promise<PeppolInboundSyncResult> {
  const { service, transport, log } = args
  const now = args.now ?? new Date()
  const result: PeppolInboundSyncResult = {
    listed: 0, archived: 0, duplicates: 0, routed: 0, unrouted: 0, delivered: 0, failed: 0,
    terminal: 0, terminalDocuments: [], errors: [],
  }
  if (!transport.listInboundDocuments) return result

  for (const documentType of ['Invoice', 'CreditNote'] as const) {
    let messages: PeppolInboundMessage[] = []
    try {
      // The cursor lets a provider that supports it skip what we already
      // hold; the archive's unique key dedupes for one that does not.
      const receivedAfter = await listingCursor(service, transport.provider, documentType)
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

    const ordered = orderInboundMessagesOldestFirst(messages)
    for (let index = 0; index < ordered.length; index += 1) {
      const message = ordered[index]
      let archived: Awaited<ReturnType<typeof archiveInboundPeppolMessage>>
      try {
        archived = await archiveInboundPeppolMessage({ service, transport, message, log, now })
      } catch (err) {
        if (err instanceof PeppolInboundArchiveError && err.deterministic) {
          try {
            const stub = await archiveUnarchivableInboundMessage({ service, message, reason: describeError(err), now })
            result.terminal += 1
            result.terminalDocuments.push({ id: stub.id, providerDocumentId: message.providerDocumentId, reason: stub.last_error ?? '' })
            log.warn('inbound Peppol payload cannot be archived, recorded as terminal', {
              providerDocumentId: message.providerDocumentId,
              reason: describeError(err),
            })
            continue
          } catch (stubErr) {
            err = stubErr
          }
        }
        const reason = describeError(err)
        result.failed += 1
        result.errors.push({ providerDocumentId: message.providerDocumentId, reason })
        log.warn('inbound Peppol listing stopped at a document that could not be archived; newer ones are re-listed next run', {
          documentType,
          providerDocumentId: message.providerDocumentId,
          reason,
          skipped: ordered.length - index - 1,
        })
        break
      }
      if (archived.created) result.archived += 1
      else result.duplicates += 1

      try {
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
        else if (processed.outcome === 'terminal') {
          result.terminal += 1
          result.terminalDocuments.push({
            id: processed.row.id,
            providerDocumentId: processed.row.provider_document_id,
            reason: processed.row.last_error ?? '',
          })
        }
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
 * Every row has a processed_at (the archive stamps it at insert), so the
 * backoff is a plain comparison; a row from before that stamp is healed by
 * the listing sync while it is still listed.
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
    candidates: 0, xmlFetched: 0, xmlMissed: 0, retried: 0, held: 0, routed: 0, delivered: 0, terminal: 0, terminalDocuments: [], errors: [],
  }

  const { data, error } = await service
    .from('peppol_inbound_documents')
    .select('*')
    .eq('provider', transport.provider)
    .in('status', ['received', 'routed', 'unrouted', 'failed'])
    .lt('processed_at', cutoff)
    // Literal on purpose: the column guard (tests/schema) can only check a
    // filter it can read, and the prefix is PEPPOL_INBOUND_TERMINAL_PREFIX.
    .or('last_error.is.null,last_error.not.like.terminal:*')
    .order('processed_at', { ascending: true })
    .limit(limit)
  if (error) throw new Error(`Failed to list pending inbound Peppol documents: ${error.message}`)
  const candidates = (data ?? []) as PeppolInboundRow[]
  result.candidates = candidates.length

  const markTerminal = (row: PeppolInboundRow) => {
    result.terminal += 1
    result.terminalDocuments.push({ id: row.id, providerDocumentId: row.provider_document_id, reason: row.last_error ?? '' })
  }

  for (const candidate of candidates) {
    // Already terminal (the query excludes these; belt and braces): not ours to touch.
    if (isTerminalInboundError(candidate.last_error)) continue
    try {
      let row = await updateRow(service, candidate.id, { processed_at: now.toISOString() })
      const hadCompany = !!row.company_id

      const xml = await fetchMissingInboundXml({ service, transport, row, log, now })
      row = xml.row
      if (xml.outcome === 'fetched') result.xmlFetched += 1
      if (xml.outcome === 'missed') result.xmlMissed += 1
      if (xml.outcome === 'terminal') {
        markTerminal(row)
        continue
      }
      // A transport error is the upstream's bad hour, not this document's: it
      // was already logged at warn with the id and is asked again after the
      // backoff. Paging on it would page every pass while the upstream is down.
      if (xml.outcome === 'error') result.retried += 1

      const processed = await processInboundPeppolRow({
        service,
        row,
        document: parseUblJsonDocument(row.ubl_json),
        deliver: args.deliver,
        log,
      })
      if (!hadCompany && processed.row.company_id) result.routed += 1
      if (processed.outcome === 'delivered') result.delivered += 1
      else if (processed.outcome === 'routed' && args.deliver) result.held += 1
      else if (processed.outcome === 'terminal') markTerminal(processed.row)
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
