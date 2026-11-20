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
/**
 * A document the read re-listing found that was received before
 * PEPPOL_INBOUND_RECOVERY_DELIVERY_WINDOW_MS: archived, its XML fetched, but
 * neither routed nor delivered until a person decides. The terminal prefix
 * keeps every pass off it, and the Peppol health digest lists it
 * (peppol-health.ts). To file it, a person clears last_error and the next
 * reprocessing pass routes and delivers it; to drop it, sets status ignored.
 */
export const PEPPOL_INBOUND_HELD_RECOVERED_PREFIX = 'terminal: held for review, found again by the re-listing'
/**
 * How old a document the re-listing finds may be and still be delivered as
 * usual. One the archive lacks is one a consumed listing lost: within days
 * it is simply late, but one from months back (lost before the re-listing
 * existed) would land in the Inkorg as a new item, with a bank match
 * proposed, without anyone at Accounted having seen it first.
 */
export const PEPPOL_INBOUND_RECOVERY_DELIVERY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000

/** Why a document the re-listing found is held, for the marker and the log. */
interface RecoveredHold {
  marker: string
  /** Which date the age was judged by; 'unknown' when the document gave neither. */
  judgedBy: 'received' | 'issued' | 'unknown'
  date: string | null
}

/**
 * Whether a document the re-listing found is held for a person rather than
 * delivered (null: delivered as usual). Its age is when the access point
 * received it, or, when the listing does not say (Qvalia's answer carries no
 * receipt time, so this is the usual case), its UBL IssueDate, mandatory in
 * BIS Billing 3. Held when the known age is past
 * PEPPOL_INBOUND_RECOVERY_DELIVERY_WINDOW_MS, and when neither date is known.
 */
function recoveredHold(message: PeppolInboundMessage, now: Date): RecoveredHold | null {
  const received = parseTimestamp(message.receivedAt)
  if (received !== null) {
    if (now.getTime() - received <= PEPPOL_INBOUND_RECOVERY_DELIVERY_WINDOW_MS) return null
    const date = new Date(received).toISOString().slice(0, 10)
    return { marker: `${PEPPOL_INBOUND_HELD_RECOVERED_PREFIX} (received ${date})`, judgedBy: 'received', date }
  }
  const issueDate = cleanIsoDate(parseUblJsonDocument(message.payload)?.issueDate ?? null)
  const issued = issueDate === null ? Number.NaN : Date.parse(`${issueDate}T00:00:00.000Z`)
  if (issueDate !== null && Number.isFinite(issued)) {
    if (now.getTime() - issued <= PEPPOL_INBOUND_RECOVERY_DELIVERY_WINDOW_MS) return null
    return {
      marker: `${PEPPOL_INBOUND_HELD_RECOVERED_PREFIX} (issued ${issueDate}, receipt time unknown)`,
      judgedBy: 'issued',
      date: issueDate,
    }
  }
  return { marker: `${PEPPOL_INBOUND_HELD_RECOVERED_PREFIX} (no receipt or issue date)`, judgedBy: 'unknown', date: null }
}

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
  /** Listing calls made this run, over both document types. */
  pages: number
  /** True in the hourly run that re-lists the last week (isPeppolInboundSweepRun). */
  sweep: boolean
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
  /** Documents the includeRead re-listing returned (after a listing that failed, and in the hourly sweep). */
  relisted: number
  /** Of those, documents the archive did not hold, archived in this run (see relistReadDocuments). */
  recovered: number
  /** Of those, documents received before the delivery window: archived and held for a person. */
  recoveredHeld: number
  /**
   * Listed documents this run had no time left for. From a listing that
   * consumes they are archived and the reprocessing pass takes them; from a
   * cursor listing they are listed again next run.
   */
  deferred: number
  /** True when the run's deadline stopped the listing before it was done. */
  outOfTime: boolean
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
  /** Candidates the run's deadline left untouched; they head the next pass (least recently processed first). */
  deferred: number
  /** Held documents (PEPPOL_INBOUND_HELD_RECOVERED_PREFIX) whose missing XML was fetched and archived this pass. */
  heldXmlFetched: number
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
 *
 * `deferXml` archives the JSON payload alone and makes no call to the
 * provider: for a listing that consumes, where every listed document must
 * have its row before anything slow or fallible is tried on any of them. The
 * caller fetches the XML afterwards (attachFirstInboundXml). `holdReason`
 * archives a new row with that last_error (PEPPOL_INBOUND_HELD_RECOVERED_PREFIX).
 */
export async function archiveInboundPeppolMessage(args: {
  service: SupabaseClient
  transport: PeppolTransport
  message: PeppolInboundMessage
  log: Logger
  now?: Date
  deferXml?: boolean
  holdReason?: string
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
    if (!args.deferXml && !row.xml_payload && isRested(row, now)) {
      row = (await fetchMissingInboundXml({ service, transport, row, log, now })).row
    }
    return { row, document: parseUblJsonDocument(row.ubl_json), created: false }
  }

  const document = parseUblJsonDocument(message.payload)
  let xml: string | null = null
  try {
    xml = transport.fetchInboundDocumentXml && !args.deferXml
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
    ...(args.holdReason ? { last_error: args.holdReason } : {}),
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
 * The first XML fetch for a row archived with `deferXml`. Same outcome as the
 * fetch archiveInboundPeppolMessage makes before its insert: the XML is
 * stored when it comes, and an empty answer or a failed call leaves the row
 * JSON-only for the reprocessing pass, without counting a miss.
 */
async function attachFirstInboundXml(args: {
  service: SupabaseClient
  transport: PeppolTransport
  row: PeppolInboundRow
  log: Logger
}): Promise<PeppolInboundRow> {
  const { service, transport, row, log } = args
  if (row.xml_payload || !transport.fetchInboundDocumentXml) return row
  let xml: string | null
  try {
    xml = await transport.fetchInboundDocumentXml(row.provider_document_id, row.document_type)
  } catch (err) {
    log.warn('inbound Peppol XML fetch failed, archived as JSON only', {
      providerDocumentId: row.provider_document_id,
      reason: describeError(err),
    })
    return row
  }
  if (!xml) return row
  return updateRow(service, row.id, { xml_payload: xml, xml_sha256: sha256Hex(xml) })
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

/** Listing calls one document type may make in a run: 10 pages of `limit` documents. */
export const PEPPOL_INBOUND_MAX_PAGES = 10

/**
 * Time a listing must leave, before the function running the pass is
 * stopped, to archive what it answers: a read and an insert per document for
 * up to a page, and the release of what is left for the reprocessing pass.
 */
export const PEPPOL_INBOUND_ARCHIVE_RESERVE_MS = 30_000
/**
 * Time a listing that consumes must also leave for the read re-listing that
 * finds what it lost (the Qvalia adapter gives that listing 60 s at most):
 * given up at its limit, the consumed listing is exactly the case the
 * re-listing is for, and it must still fit before the function's end.
 */
export const PEPPOL_INBOUND_RELIST_RESERVE_MS = 60_000
/** A listing is not asked for with less time than this to answer in. */
export const PEPPOL_INBOUND_MIN_LISTING_MS = 10_000
/** Documents the includeRead re-listing asks for: the most Qvalia lists per call. */
export const PEPPOL_INBOUND_RELIST_LIMIT = 100

/**
 * How far back the hourly sweep lists again. The cursor only moves forward,
 * so a document the provider holds behind it (received out of order, or
 * listed while an older one blocked the type) would otherwise never be
 * listed; the sweep re-lists the last week and the archive's unique key
 * absorbs everything already held. A week of more than
 * PEPPOL_INBOUND_MAX_PAGES pages is swept up to the cap; the ordinary runs
 * cover the newest end.
 */
export const PEPPOL_INBOUND_SWEEP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** The first run of each hour sweeps (UTC minute 0 to 9; the cron runs every ten minutes). */
export function isPeppolInboundSweepRun(now: Date): boolean {
  return now.getUTCMinutes() < 10
}

/**
 * The cursor for the page after this one: one second before the newest
 * `receivedAt` it listed, for the same reason as listingCursor. Null when no
 * timestamp in the page parses.
 */
function nextPageCursor(messages: PeppolInboundMessage[]): string | null {
  let newest: number | null = null
  for (const message of messages) {
    const at = parseTimestamp(message.receivedAt)
    if (at !== null && (newest === null || at > newest)) newest = at
  }
  return newest === null ? null : new Date(newest - 1000).toISOString()
}

/** The earlier of two cursors; no cursor (list from the start) is the earliest. */
function earlierCursor(a: string | null, b: string | null): string | null {
  if (a === null || b === null) return null
  return Date.parse(a) <= Date.parse(b) ? a : b
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
 * archive, route and deliver each, oldest first. A full page (`limit`
 * documents) is followed by the next one, the cursor moved to one second
 * before the newest document listed, up to PEPPOL_INBOUND_MAX_PAGES per type;
 * paging stops at a short page, at a full page that does not move the cursor
 * (a provider that ignores it, or answers newest first) and at the cap, and
 * the next run carries on from the archive. The first run of each hour sweeps
 * instead: it starts from a week back (never later than the archive cursor)
 * and pages the same way.
 *
 * Processing errors are per document; an archive failure stops the document
 * type for this run, because archiving a newer document past an older one
 * that is not in the archive would move the listing cursor beyond it (the
 * provider re-lists the rest next run; the archive's unique key tolerates the
 * repeat). A payload the archive can never hold is recorded as a terminal
 * stub instead, so it does not block the cursor forever. A listing that
 * consumes (transport.inboundListingConsumes: Qvalia direct marks the page
 * read) never re-lists, so there the failure is an error and the rest of the
 * page is still archived; after a listing that failed, and in the hourly
 * sweep, read documents are listed again (relistReadDocuments).
 *
 * `deadline` (epoch ms) bounds the pass: it is checked before every listing
 * call and before every document, and what is left is counted in `deferred`.
 * `functionEndsAt` (epoch ms) is when the function running the pass is
 * stopped: a listing may take until PEPPOL_INBOUND_ARCHIVE_RESERVE_MS before
 * it (the listing's own time limit, timeoutMs), and is not asked for with
 * less than PEPPOL_INBOUND_MIN_LISTING_MS of that left, because a listing
 * that consumes hands its page over when the provider answers.
 */
export async function syncInboundPeppolDocuments(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  limit?: number
  now?: Date
  deadline?: number
  functionEndsAt?: number
}): Promise<PeppolInboundSyncResult> {
  const { service, transport, log } = args
  const now = args.now ?? new Date()
  const limit = args.limit ?? 50
  const sweep = isPeppolInboundSweepRun(now)
  const result: PeppolInboundSyncResult = {
    pages: 0, sweep, listed: 0, archived: 0, duplicates: 0, routed: 0, unrouted: 0, delivered: 0, failed: 0,
    terminal: 0, terminalDocuments: [], relisted: 0, recovered: 0, recoveredHeld: 0, deferred: 0, outOfTime: false, errors: [],
  }
  if (!transport.listInboundDocuments) return result
  // A consumed listing keeps back time for the re-listing that follows a
  // failure; the re-listing keeps back time to archive what it finds.
  const consumedReserve = transport.inboundListingConsumes ? PEPPOL_INBOUND_RELIST_RESERVE_MS : 0
  const timeLeft = (reserveMs: number) =>
    args.functionEndsAt === undefined ? undefined : args.functionEndsAt - Date.now() - reserveMs
  const clock: ListingClock = {
    outOfTime: () => args.deadline !== undefined && Date.now() >= args.deadline,
    listingTime: () => timeLeft(PEPPOL_INBOUND_ARCHIVE_RESERVE_MS + consumedReserve),
    relistTime: () => timeLeft(PEPPOL_INBOUND_ARCHIVE_RESERVE_MS),
  }
  const page = { service, transport, deliver: args.deliver, log, now, result, clock }

  for (const documentType of ['Invoice', 'CreditNote'] as const) {
    if (result.outOfTime) break
    // The cursor lets a provider that supports it skip what we already hold;
    // the archive's unique key dedupes for one that does not.
    let receivedAfter: string | null
    try {
      receivedAfter = await listingCursor(service, transport.provider, documentType)
    } catch (err) {
      log.error('inbound Peppol listing failed', err as Error, { documentType })
      result.errors.push({ providerDocumentId: `list:${documentType}`, reason: describeError(err) })
      continue
    }
    if (sweep) {
      receivedAfter = earlierCursor(receivedAfter, new Date(now.getTime() - PEPPOL_INBOUND_SWEEP_WINDOW_MS).toISOString())
    }

    let listingFailed = false
    for (let pageNumber = 1; pageNumber <= PEPPOL_INBOUND_MAX_PAGES; pageNumber += 1) {
      const timeoutMs = clock.listingTime()
      if (clock.outOfTime() || (timeoutMs !== undefined && timeoutMs < PEPPOL_INBOUND_MIN_LISTING_MS)) {
        result.outOfTime = true
        break
      }
      let messages: PeppolInboundMessage[]
      try {
        messages = await transport.listInboundDocuments({
          documentType,
          limit,
          ...(receivedAfter ? { receivedAfter } : {}),
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        })
      } catch (err) {
        log.error('inbound Peppol listing failed', err as Error, { documentType, page: pageNumber })
        result.errors.push({ providerDocumentId: `list:${documentType}`, reason: describeError(err) })
        listingFailed = true
        break
      }
      result.pages += 1
      result.listed += messages.length

      const archiveStopped = await archiveListedPage({
        ...page, documentType, messages, listing: transport.inboundListingConsumes ? 'consumed' : 'cursor',
      })
      if (archiveStopped || messages.length < limit) break

      const next = nextPageCursor(messages)
      if (next === null || (receivedAfter !== null && Date.parse(next) <= Date.parse(receivedAfter))) {
        log.warn('inbound Peppol listing returned a full page that does not move the cursor; the rest is listed next run', {
          documentType,
          page: pageNumber,
          receivedAfter,
        })
        break
      }
      receivedAfter = next
      if (pageNumber === PEPPOL_INBOUND_MAX_PAGES) {
        log.info('inbound Peppol listing reached the page cap; the rest is listed next run', { documentType, pages: pageNumber })
      }
    }

    if (transport.inboundListingConsumes && (sweep || listingFailed)) {
      await relistReadDocuments({ ...page, documentType, afterFailure: listingFailed })
    }
  }

  return result
}

/** The two limits a listing pass works inside (see syncInboundPeppolDocuments). */
interface ListingClock {
  /** True once the pass's deadline has passed: no new listing or document is started. */
  outOfTime: () => boolean
  /** How long a listing asked for now may take, or undefined when the caller set no end. */
  listingTime: () => number | undefined
  /** The same for the read re-listing, which keeps back only the archive reserve. */
  relistTime: () => number | undefined
}

/**
 * Find again what a listing that consumes handed over without the answer
 * reaching us. The provider marks a listed page read when it answers, also
 * when we gave the call up or the answer was lost on the way, and its read
 * listing never returns those documents again. Its plain listing with
 * includeRead does, and marks nothing (Qvalia: `incoming?includeRead=true`,
 * up to PEPPOL_INBOUND_RELIST_LIMIT documents; which ones, newest or oldest,
 * is not documented, and it takes no date filter). Asked for after a
 * listing that failed and once an hour in the sweep. Whatever it returns that
 * the archive does not hold is archived, routed and delivered like a consumed
 * page (one received before PEPPOL_INBOUND_RECOVERY_DELIVERY_WINDOW_MS is
 * archived but held for a person); the rest is left to the passes that own
 * it. A failure here is a warning: this listing hands nothing over, and the
 * next sweep asks again.
 *
 * After a listing that failed (`afterFailure`), the pass's deadline does not
 * stop it, only the function's end does: the page that listing may have
 * handed over is found now or an hour later at the earliest.
 */
async function relistReadDocuments(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  documentType: PeppolInboundDocumentType
  now: Date
  result: PeppolInboundSyncResult
  clock: ListingClock
  afterFailure: boolean
}): Promise<void> {
  const { service, transport, log, documentType, result, clock } = args
  if (!transport.listInboundDocuments) return
  const timeoutMs = clock.relistTime()
  if ((!args.afterFailure && clock.outOfTime()) || (timeoutMs !== undefined && timeoutMs < PEPPOL_INBOUND_MIN_LISTING_MS)) {
    result.outOfTime = true
    return
  }
  let messages: PeppolInboundMessage[]
  let held: Set<string>
  try {
    messages = await transport.listInboundDocuments({
      documentType,
      limit: PEPPOL_INBOUND_RELIST_LIMIT,
      includeRead: true,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    })
    result.relisted += messages.length
    held = await archivedProviderDocumentIds(service, transport.provider, messages.map((message) => message.providerDocumentId))
  } catch (err) {
    log.warn('inbound Peppol re-listing of read documents failed; the next sweep asks again', {
      documentType,
      reason: describeError(err),
    })
    return
  }
  const missing = messages.filter((message) => !held.has(message.providerDocumentId))
  if (missing.length === 0) return
  result.recovered += missing.length
  log.warn('inbound Peppol re-listing found documents the archive did not hold; archiving them', {
    documentType,
    count: missing.length,
    providerDocumentIds: missing.slice(0, 20).map((message) => message.providerDocumentId),
  })
  await archiveListedPage({ ...args, messages: missing, listing: 'relisted' })
}

/** Which of `ids` the archive holds for `provider`, in one read. */
async function archivedProviderDocumentIds(
  service: SupabaseClient,
  provider: string,
  ids: string[],
): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const { data, error } = await service
    .from('peppol_inbound_documents')
    .select('provider_document_id')
    .eq('provider', provider)
    .in('provider_document_id', ids)
  if (error) throw new Error(`Failed to read the inbound Peppol archive: ${error.message}`)
  return new Set(((data ?? []) as Array<{ provider_document_id: string }>).map((row) => row.provider_document_id))
}

/**
 * Archive, route and deliver one listed page, oldest first, counting into
 * `result`. True when the document type must stop here: a document could not
 * be archived, or the run is out of time, and the cursor must never pass a
 * document the archive does not hold (the provider lists the rest again next
 * run). Only ever true for a cursor listing.
 *
 * A page the provider has handed over ('consumed': it marked the page read;
 * 'relisted': documents a consumed page lost, found again) is archived in two
 * steps instead: first a row for every document, from the JSON already in
 * hand and without a call to the provider, then the XML fetch and the
 * delivery, one document at a time. Nothing lists read documents in the
 * ordinary runs, so when the XML was fetched and the document delivered
 * before the next one was archived, a run that ended mid-page (a hung call,
 * the function's time limit) lost the rest of the page without a row
 * anywhere. Now a run that ends after the first step has left rows the
 * reprocessing pass picks up.
 */
async function archiveListedPage(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  documentType: PeppolInboundDocumentType
  messages: PeppolInboundMessage[]
  now: Date
  result: PeppolInboundSyncResult
  clock: ListingClock
  listing: 'consumed' | 'relisted' | 'cursor'
}): Promise<boolean> {
  const { service, transport, log, documentType, now, result, clock, listing } = args
  const handedOver = listing !== 'cursor'
  const ordered = orderInboundMessagesOldestFirst(args.messages)
  type Archived = Awaited<ReturnType<typeof archiveInboundPeppolMessage>>

  /** The archive row for one message; null when it has none to process, 'stop' when the type stops here. */
  const archive = async (message: PeppolInboundMessage, index: number): Promise<Archived | null | 'stop'> => {
    try {
      const hold = listing === 'relisted' ? recoveredHold(message, now) : null
      const archived = await archiveInboundPeppolMessage({
        service, transport, message, log, now, deferXml: handedOver, holdReason: hold?.marker,
      })
      if (archived.created) result.archived += 1
      else result.duplicates += 1
      if (archived.created && hold) {
        result.recoveredHeld += 1
        log.warn(
          hold.judgedBy === 'unknown'
            ? 'inbound Peppol document found again by the re-listing has no receipt or issue date; held for a person'
            : `inbound Peppol document found again by the re-listing was ${hold.judgedBy} more than 14 days ago; held for a person`,
          { documentType, providerDocumentId: message.providerDocumentId, judgedBy: hold.judgedBy, date: hold.date },
        )
      }
      return archived
    } catch (caught) {
      let err = caught
      if (err instanceof PeppolInboundArchiveError && err.deterministic) {
        try {
          const stub = await archiveUnarchivableInboundMessage({ service, message, reason: describeError(err), now })
          result.terminal += 1
          result.terminalDocuments.push({ id: stub.id, providerDocumentId: message.providerDocumentId, reason: stub.last_error ?? '' })
          log.warn('inbound Peppol payload cannot be archived, recorded as terminal', {
            providerDocumentId: message.providerDocumentId,
            reason: describeError(err),
          })
          return null
        } catch (stubErr) {
          err = stubErr
        }
      }
      const reason = describeError(err)
      result.failed += 1
      if (listing === 'relisted') {
        // Still listed with includeRead: the next sweep finds it again.
        log.warn('inbound Peppol document found by the re-listing could not be archived; the next sweep tries again', {
          documentType,
          providerDocumentId: message.providerDocumentId,
          reason,
        })
        return null
      }
      result.errors.push({ providerDocumentId: message.providerDocumentId, reason })
      if (listing === 'consumed') {
        // The provider has handed the page over: stopping here would lose the
        // rest of it, and this document is not listed again either.
        log.error('inbound Peppol document could not be archived; the provider does not list it again', err as Error, {
          documentType,
          providerDocumentId: message.providerDocumentId,
        })
        return null
      }
      log.warn('inbound Peppol listing stopped at a document that could not be archived; newer ones are re-listed next run', {
        documentType,
        providerDocumentId: message.providerDocumentId,
        reason,
        skipped: ordered.length - index - 1,
      })
      return 'stop'
    }
  }

  /** Route and deliver an archived row, after the XML fetch a deferred archive left out. */
  const routeAndDeliver = async (archived: Archived) => {
    try {
      let row = archived.row
      if (handedOver && archived.created) {
        row = await attachFirstInboundXml({ service, transport, row, log })
      } else if (handedOver && !row.xml_payload && isRested(row, now)) {
        row = (await fetchMissingInboundXml({ service, transport, row, log, now })).row
      }
      const processed = await processInboundPeppolRow({
        service,
        row,
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
      const providerDocumentId = archived.row.provider_document_id
      result.failed += 1
      result.errors.push({ providerDocumentId, reason: describeError(err) })
      log.error('inbound Peppol document failed', err as Error, { providerDocumentId })
    }
  }

  if (handedOver) {
    const rows: Archived[] = []
    for (const [index, message] of ordered.entries()) {
      const archived = await archive(message, index)
      if (archived && archived !== 'stop') rows.push(archived)
    }
    const left: string[] = []
    for (const archived of rows) {
      if (listing === 'relisted' && isTerminalInboundError(archived.row.last_error)) {
        // Held for a person (or terminal before this run): never routed or
        // delivered here. A held row still gets its exact XML when there is time.
        if (archived.created && !clock.outOfTime()) {
          try {
            await attachFirstInboundXml({ service, transport, row: archived.row, log })
          } catch (err) {
            log.warn('inbound Peppol XML of a held document could not be stored; it is fetched when the hold is cleared', {
              providerDocumentId: archived.row.provider_document_id,
              reason: describeError(err),
            })
          }
        }
        continue
      }
      if (clock.outOfTime()) left.push(archived.row.id)
      else await routeAndDeliver(archived)
    }
    if (left.length > 0) {
      result.deferred += left.length
      result.outOfTime = true
      // Nothing has been tried on these rows yet: stamp them as rested, so the
      // reprocessing pass takes them on its next pass and not a backoff later.
      const rested = new Date(now.getTime() - PEPPOL_INBOUND_REPROCESS_BACKOFF_MS - 1000).toISOString()
      const { error } = await service.from('peppol_inbound_documents').update({ processed_at: rested }).in('id', left)
      if (error) {
        log.warn('inbound Peppol documents left at the deadline wait out the backoff before they are reprocessed', {
          documentType,
          count: left.length,
          reason: error.message,
        })
      }
    }
    return false
  }

  for (const [index, message] of ordered.entries()) {
    if (clock.outOfTime()) {
      result.deferred += ordered.length - index
      result.outOfTime = true
      return true
    }
    const archived = await archive(message, index)
    if (archived === 'stop') return true
    if (archived) await routeAndDeliver(archived)
  }
  return false
}

/**
 * Reprocessing pass over the archive, independent of what the provider
 * lists: every row still pending (`received`, `routed`, `unrouted`, `failed`)
 * that has rested for the backoff is examined again, terminal rows excluded.
 * Rows still `received` come first (archived, never routed: a run that ended
 * after archiving a consumed page), then the rest, least recently processed
 * first. In one queue, a newly received row waited behind every row that can
 * never finish (an unrouted document nobody registers for is pending for
 * good), 25 per run, in the order they were last examined. For each: the missing XML is
 * fetched, routing is re-run (a registration that appeared since routes a
 * previously unrouted document) and the inbox delivery is attempted.
 *
 * Every candidate is stamped `processed_at = now` before anything else, so a
 * row is never examined twice within one backoff whatever happens to it.
 * Every row has a processed_at (the archive stamps it at insert), so the
 * backoff is a plain comparison; a row from before that stamp is healed by
 * the listing sync while it is still listed.
 *
 * `deadline` (epoch ms) is checked before every candidate; the ones it leaves
 * are not stamped, so they head the next pass.
 */
export async function reprocessInboundPeppolDocuments(args: {
  service: SupabaseClient
  transport: PeppolTransport
  deliver: PeppolInboundDeliverer | null
  log: Logger
  limit?: number
  now?: Date
  deadline?: number
}): Promise<PeppolInboundReprocessResult> {
  const { service, transport, log } = args
  const limit = args.limit ?? 25
  const now = args.now ?? new Date()
  const cutoff = new Date(now.getTime() - PEPPOL_INBOUND_REPROCESS_BACKOFF_MS).toISOString()
  const result: PeppolInboundReprocessResult = {
    candidates: 0, xmlFetched: 0, xmlMissed: 0, retried: 0, held: 0, routed: 0, delivered: 0, terminal: 0, terminalDocuments: [], deferred: 0,
    heldXmlFetched: 0, errors: [],
  }

  const pending = async (statuses: PeppolInboundStatus[], count: number): Promise<PeppolInboundRow[]> => {
    const { data, error } = await service
      .from('peppol_inbound_documents')
      .select('*')
      .eq('provider', transport.provider)
      .in('status', statuses)
      .lt('processed_at', cutoff)
      // Literal on purpose: the column guard (tests/schema) can only check a
      // filter it can read, and the prefix is PEPPOL_INBOUND_TERMINAL_PREFIX.
      .or('last_error.is.null,last_error.not.like.terminal:*')
      .order('processed_at', { ascending: true })
      .limit(count)
    if (error) throw new Error(`Failed to list pending inbound Peppol documents: ${error.message}`)
    return (data ?? []) as PeppolInboundRow[]
  }
  const received = await pending(['received'], limit)
  const candidates = received.length < limit
    ? [...received, ...(await pending(['routed', 'unrouted', 'failed'], limit - received.length))]
    : received
  result.candidates = candidates.length

  const markTerminal = (row: PeppolInboundRow) => {
    result.terminal += 1
    result.terminalDocuments.push({ id: row.id, providerDocumentId: row.provider_document_id, reason: row.last_error ?? '' })
  }

  for (const [index, candidate] of candidates.entries()) {
    if (args.deadline !== undefined && Date.now() >= args.deadline) {
      result.deferred = candidates.length - index
      break
    }
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

  await fetchHeldInboundXml({ service, transport, log, now, cutoff, limit, deadline: args.deadline, result })
  return result
}

/**
 * The exact XML of documents held for a person (found again by the
 * re-listing, PEPPOL_INBOUND_HELD_RECOVERED_PREFIX). They are terminal, so
 * the pass above never takes them and fetchMissingInboundXml skips them, but
 * the archive should hold the e-invoice as received whatever the person
 * decides: one the re-listing archived after its run's deadline has no XML
 * yet. This fetch is all that is done to them; each attempt rests the row
 * for the backoff.
 */
async function fetchHeldInboundXml(args: {
  service: SupabaseClient
  transport: PeppolTransport
  log: Logger
  now: Date
  cutoff: string
  limit: number
  deadline: number | undefined
  result: PeppolInboundReprocessResult
}): Promise<void> {
  const { service, transport, log, result } = args
  const outOfTime = () => args.deadline !== undefined && Date.now() >= args.deadline
  if (!transport.fetchInboundDocumentXml || outOfTime()) return
  const { data, error } = await service
    .from('peppol_inbound_documents')
    .select('*')
    .eq('provider', transport.provider)
    .like('last_error', `${PEPPOL_INBOUND_HELD_RECOVERED_PREFIX}%`)
    .is('xml_payload', null)
    .lt('processed_at', args.cutoff)
    .order('processed_at', { ascending: true })
    .limit(args.limit)
  if (error) {
    log.warn('held inbound Peppol documents without XML could not be listed; the next pass asks again', { reason: error.message })
    return
  }
  for (const row of (data ?? []) as PeppolInboundRow[]) {
    if (outOfTime()) return
    try {
      const rested = await updateRow(service, row.id, { processed_at: args.now.toISOString() })
      const stored = await attachFirstInboundXml({ service, transport, row: rested, log })
      if (stored.xml_payload) result.heldXmlFetched += 1
    } catch (err) {
      log.warn('XML of a held inbound Peppol document could not be stored; asked again after the backoff', {
        id: row.id,
        providerDocumentId: row.provider_document_id,
        reason: describeError(err),
      })
    }
  }
}
