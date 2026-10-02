/**
 * Qvalia Peppol Access Point adapter.
 *
 * Qvalia (PSE000094) is the contracted Access Point + SMP. This module is the
 * only place that knows Qvalia's HTTP surface; everything else speaks the
 * provider-neutral `PeppolTransport` boundary.
 *
 * API facts (https://api.qvalia.io; verified live 2026-08-21, re-read against
 * the docs 2026-09-21 after Qvalia's API update):
 * - Production `https://api.qvalia.com`, sandbox `https://api-test.qvalia.com`,
 *   separate keys per environment. (The docs named api-qa in August; they now
 *   name api-test, the host that always answered.)
 * - Auth: the bare key in `Authorization: <key>` (verified live against the
 *   sandbox 2026-08-21, and what the docs say since the September correction).
 *   The `ApiKey <key>` form from the August docs answered 401 and stays opt-in
 *   via QVALIA_AUTH_SCHEME=apikey.
 * - Partner model: every call is `/partner/{partnerRegNo}/...`; transactions
 *   are `/partner/{partnerRegNo}/transaction/{accountRegNo}/invoices/outgoing`.
 *   In the consolidated setup all customer Peppol IDs live under one account
 *   and `accountRegNo` equals `partnerRegNo`.
 * - Outgoing invoice: POST the BIS Billing 3 UBL XML with
 *   `content-type: application/xml`; the response carries an `integrationId`
 *   (UUID) that identifies the message at Qvalia. The same document id for the
 *   same receiver answers `409`; with `?overwrite=true` (a resend after a
 *   failed delivery) Qvalia sends it again under a new `integrationId`.
 *   `integrationId` appears in several places of the response, always with
 *   the same value (by design per Qvalia). Since
 *   September the docs also describe an `Idempotency-Key` request header (a
 *   repeat within 24 h returns the original response and `integrationId`);
 *   this adapter does not send it yet and relies on the 409 recovery below.
 * - Recipient lookup: GET `/partner/{p}/peppol/lookup/{scheme:id}?docTypeRoot=Invoice`.
 * - Webhooks: since September Qvalia signs deliveries with HMAC-SHA256
 *   (`X-Qvalia-Signature: t=<unix>,v1=<hex>` over `<t>.<raw body>`, plus
 *   `X-Qvalia-Event-Id`; the signing secret is returned once by the first
 *   `PUT .../webhook/configure`). With QVALIA_WEBHOOK_SIGNING_SECRET set,
 *   verifyWebhook requires that signature (raw body bytes, timing-safe,
 *   5-minute window on the signed `t`) and ignores the shared-secret header;
 *   without it the adapter falls back to the outbound auth header the partner
 *   configures (shared secret, QVALIA_WEBHOOK_SECRET), which is what it did
 *   before Qvalia signed anything. Dedupe is unchanged: eventType +
 *   globalTransactionId + status.status, the key the status poll also writes,
 *   so a webhook and a poll for the same transition stay one event. The
 *   payload's `eventId` (Qvalia's dedupe key) is not used for that reason.
 * - Webhook delivery is NOT retried by Qvalia: a non-2xx answer, a timeout
 *   (10 s) or an unreachable endpoint loses the event for good, so webhooks
 *   can never be the only source of truth. `pollDeliveryStatus` is the safety
 *   net and stays.
 * - Status values are documented since September: `pending`, `delayed`
 *   (a Peppol send inside its retry window, up to 24 h; also its own event
 *   type `document_delayed`) and `warning` are non-terminal; `processed`,
 *   `processed_with_warning` and `error` are terminal. The field is still
 *   declared free text: the webhook mapping keeps unknown wording as "no
 *   change", while the status poll maps only the documented values and
 *   refuses anything else (mapQvaliaOutgoingStatus).
 * - Outgoing status: GET `.../invoices/outgoing/status?integrationId=...`
 *   answers `{ status, data: [record] }` with the message-log OBJECT in
 *   `metadata.status`, not the string the docs show, and 204 for an
 *   integrationId Qvalia does not know (verified against the sandbox
 *   2026-09-29). See readQvaliaOutgoingStatus.
 */

import { timingSafeEqual } from 'node:crypto'
import { sha256Hex } from '@/lib/invoices/peppol-delivery'
import { verifySignatureHeader } from '@/lib/webhooks/signing'
import {
  PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID,
  PEPPOL_BIS_BILLING_PROFILE_ID,
} from '@/lib/invoices/peppol-bis-billing'
import {
  PEPPOL_UPSTREAM_SHAPE_CODE,
  PeppolTransportError,
  type PeppolDeliveryEvidence,
  type PeppolDeliveryStatus,
  type PeppolInboundDocumentType,
  type PeppolInboundListOptions,
  type PeppolInboundMessage,
  type PeppolParticipant,
  type PeppolRecipientCapability,
  type PeppolRecipientLookup,
  type PeppolRecipientRegistration,
  type PeppolRecipientRegistrationInput,
  type PeppolSubmission,
  type PeppolSubmissionReceipt,
  type PeppolTransport,
  type PeppolVerifiedEvent,
  type PeppolWebhookRequest,
} from '@/lib/invoices/peppol-transport'

export const QVALIA_PROVIDER = 'qvalia'
export const QVALIA_PRODUCTION_BASE_URL = 'https://api.qvalia.com'
export const QVALIA_DEFAULT_WEBHOOK_HEADER = 'x-accounted-webhook-key'
export const QVALIA_SIGNATURE_HEADER = 'x-qvalia-signature'
/** Qvalia's recommended replay window for the signed timestamp. */
export const QVALIA_SIGNATURE_TOLERANCE_SECONDS = 300

export type QvaliaAuthScheme = 'apikey' | 'raw'

export interface QvaliaConfig {
  apiKey: string
  /** Partner registration number issued by Qvalia. */
  partnerRegNo: string
  /**
   * Account registration number the documents are sent from. Consolidated
   * setup: the partner account itself. Multi-tenant setup (later): one per
   * Accounted company.
   */
  accountRegNo: string
  baseUrl: string
  authScheme: QvaliaAuthScheme
  /**
   * Shared secret Qvalia sends back in `webhookHeader` on every webhook
   * delivery. The legacy authentication, used only while
   * `webhookSigningSecret` is unset.
   */
  webhookSecret: string | null
  /** Header name carrying the shared secret (compared case-insensitively). */
  webhookHeader: string
  /**
   * HMAC-SHA256 signing secret Qvalia returned once from the first
   * `PUT .../webhook/configure`. When set, every webhook must carry a valid
   * `X-Qvalia-Signature` and the shared-secret header is not consulted.
   */
  webhookSigningSecret?: string | null
}

export interface QvaliaTransportDeps {
  fetch?: typeof fetch
  now?: () => Date
}

/**
 * Read the adapter configuration from the environment. Returns `null` when
 * the mandatory values are absent so the transport stays unregistered and the
 * product truthfully reports "provider adapter unavailable".
 */
export function readQvaliaConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): QvaliaConfig | null {
  const apiKey = env.QVALIA_API_KEY?.trim()
  const partnerRegNo = env.QVALIA_PARTNER_REG_NO?.trim()
  const baseUrl = env.QVALIA_BASE_URL?.trim().replace(/\/+$/, '')
  if (!apiKey || !partnerRegNo || !baseUrl) return null
  if (!/^https:\/\//i.test(baseUrl)) return null

  const authSchemeRaw = env.QVALIA_AUTH_SCHEME?.trim().toLowerCase()
  const authScheme: QvaliaAuthScheme = authSchemeRaw === 'apikey' ? 'apikey' : 'raw'

  return {
    apiKey,
    partnerRegNo,
    accountRegNo: env.QVALIA_ACCOUNT_REG_NO?.trim() || partnerRegNo,
    baseUrl,
    authScheme,
    webhookSecret: env.QVALIA_WEBHOOK_SECRET?.trim() || null,
    webhookHeader: (env.QVALIA_WEBHOOK_HEADER?.trim() || QVALIA_DEFAULT_WEBHOOK_HEADER).toLowerCase(),
    webhookSigningSecret: env.QVALIA_WEBHOOK_SIGNING_SECRET?.trim() || null,
  }
}

export type QvaliaErrorKind =
  | 'rejected'
  | 'duplicate'
  | 'auth'
  | 'rate_limited'
  | 'unavailable'
  | 'network'
  | 'protocol'
  | 'shape'

/**
 * One error type for every Qvalia failure. `kind` tells the caller whether a
 * retry can help: `rejected` and `duplicate` are permanent for this document,
 * `shape` (an answer this adapter cannot read, code
 * PEPPOL_UPSTREAM_SHAPE_CODE) is permanent until the adapter learns the
 * shape, everything else is operational.
 */
export class QvaliaApiError extends PeppolTransportError {
  readonly kind: QvaliaErrorKind
  readonly httpStatus: number | null

  constructor(kind: QvaliaErrorKind, message: string, options: {
    httpStatus?: number | null
    detail?: string | null
    cause?: unknown
  } = {}) {
    super(message, {
      retryable: kind !== 'rejected' && kind !== 'duplicate' && kind !== 'shape',
      detail: options.detail ?? null,
      code: kind === 'shape' ? PEPPOL_UPSTREAM_SHAPE_CODE : null,
      cause: options.cause,
    })
    this.name = 'QvaliaApiError'
    this.kind = kind
    this.httpStatus = options.httpStatus ?? null
  }
}

function authorizationHeader(config: QvaliaConfig): string {
  return config.authScheme === 'raw' ? config.apiKey : `ApiKey ${config.apiKey}`
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value)
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Pull a human-readable reason out of Qvalia's varied error envelopes. */
export function describeQvaliaErrorBody(body: unknown): string | null {
  const record = asRecord(body)
  if (!record) return typeof body === 'string' && body.trim() ? body.trim().slice(0, 500) : null
  const metadata = asRecord(record.metadata)
  const candidates: unknown[] = [
    metadata?.description,
    metadata?.debug_error_message,
    record.message,
    record.error,
    record.data,
  ]
  for (const candidate of candidates) {
    const text = asString(candidate)
    if (text) return text.slice(0, 500)
  }
  const details = metadata?.details
  if (details && typeof details === 'object') {
    try {
      return JSON.stringify(details).slice(0, 500)
    } catch {
      return null
    }
  }
  return null
}

async function readBody(response: Response): Promise<{ text: string; json: unknown }> {
  const text = await response.text()
  if (!text) return { text, json: null }
  try {
    return { text, json: JSON.parse(text) as unknown }
  } catch {
    return { text, json: null }
  }
}

function classifyHttpFailure(status: number, body: unknown, text: string): QvaliaApiError {
  const detail = describeQvaliaErrorBody(body) ?? (text.trim() ? text.trim().slice(0, 500) : null)
  if (status === 400 || status === 422) {
    return new QvaliaApiError('rejected', `Qvalia rejected the document (${status})`, {
      httpStatus: status,
      detail,
    })
  }
  if (status === 409) {
    return new QvaliaApiError('duplicate', 'Qvalia already holds a document with this id for this receiver', {
      httpStatus: status,
      detail,
    })
  }
  if (status === 401 || status === 403) {
    return new QvaliaApiError('auth', `Qvalia refused the API credentials (${status})`, {
      httpStatus: status,
      detail,
    })
  }
  if (status === 429) {
    return new QvaliaApiError('rate_limited', 'Qvalia rate limit reached', {
      httpStatus: status,
      detail,
    })
  }
  return new QvaliaApiError('unavailable', `Qvalia answered ${status}`, {
    httpStatus: status,
    detail,
  })
}

/** First `<cbc:ID>` of a UBL document is the document number (after CustomizationID/ProfileID). */
export function extractUblDocumentId(xml: string): string | null {
  const match = /<cbc:ID(?:\s[^>]*)?>([^<]+)<\/cbc:ID>/.exec(xml)
  if (!match) return null
  // Single pass: a sequential chain would double-unescape "&amp;lt;".
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
  const value = match[1]
    .replace(/&(amp|lt|gt|quot|apos);/g, (_, name: string) => entities[name])
    .trim()
  return value || null
}

/**
 * UBL-JSON as Qvalia returns it (verified live 2026-08-21): xml2js style, so
 * element keys keep their namespace prefix (`cac:AccountingSupplierParty`,
 * `cbc:EndpointID`), every element is an array, text sits under `_` and
 * attributes under `$`. The OASIS UBL-JSON form (unprefixed keys, attributes
 * beside `_`) is accepted too.
 */
function ublChild(record: Record<string, unknown> | null, name: string): unknown {
  if (!record) return undefined
  return record[name] ?? record[`cac:${name}`] ?? record[`cbc:${name}`]
}

function ublAttribute(element: Record<string, unknown> | null, name: string): string | null {
  if (!element) return null
  return asString(element[name]) ?? asString(asRecord(element.$)?.[name])
}

/** Dig the seller endpoint identifier out of a UBL-JSON invoice message. */
export function extractUblJsonSupplierEndpoint(message: unknown): PeppolParticipant | null {
  const record = asRecord(message)
  if (!record) return null
  const invoice = asRecord(ublChild(record, 'Invoice')) ?? record
  const supplierParty = firstRecord(ublChild(invoice, 'AccountingSupplierParty'))
  const party = firstRecord(ublChild(supplierParty, 'Party'))
  const endpoint = firstRecord(ublChild(party, 'EndpointID'))
  const identifier = asString(endpoint?._)
  const scheme = ublAttribute(endpoint, 'schemeID')
  if (!identifier || !scheme) return null
  return { scheme, identifier }
}

function firstRecord(value: unknown): Record<string, unknown> | null {
  if (Array.isArray(value)) return asRecord(value[0])
  return asRecord(value)
}

function extractIntegrationId(message: unknown): string | null {
  const record = asRecord(message)
  if (!record) return null
  return asString(record.integrationId) ?? asString(asRecord(record.Invoice)?.integrationId)
}

function participantsEqual(a: PeppolParticipant, b: PeppolParticipant): boolean {
  return a.scheme === b.scheme
    && a.identifier.replace(/[\s-]/g, '') === b.identifier.replace(/[\s-]/g, '')
}

/**
 * Qvalia's message-log status object. The webhook carries it in `status`,
 * `/invoices/outgoing/status` in `metadata.status`. `status` is absent until
 * the message has an outcome (event `message-log/create`).
 */
export interface QvaliaMessageStatus {
  status?: string
  event?: string
  deliveryMethod?: string
  updatedAt?: string
}

/** Webhook payload shape as documented on api.qvalia.io (one flat object). */
export interface QvaliaWebhookPayload {
  eventType: 'new_document' | 'document_delivery' | 'document_error' | string
  accountRegNo?: string
  documentType?: string
  direction?: 'outgoing' | 'incoming' | string
  integrationId?: string
  occurredAt?: string
  documentId?: string
  globalTransactionId?: string
  status?: QvaliaMessageStatus
  error?: string | null
  peppol_metadata?: Record<string, unknown> | null
}

export interface QvaliaNormalizedStatus {
  eventCode: string
  normalizedStatus: PeppolDeliveryStatus
  isTerminal: boolean
  detail: string | null
}

const PERMANENT_ERROR_RE = /validat|schema|conform|invalid|malformed|not registered|unknown (?:recipient|receiver|participant)|no (?:such )?(?:recipient|receiver|participant)|not found in (?:smp|sml|peppol)/i

/**
 * Map Qvalia's free-text delivery statuses onto the lifecycle. `status.status`
 * is explicitly "not a fixed enum and may change" in Qvalia's docs, so the
 * mapping is tolerant: unknown wording never advances beyond what the event
 * type itself proves, and the raw wording is kept in `detail`.
 */
export function normalizeQvaliaWebhook(payload: QvaliaWebhookPayload): QvaliaNormalizedStatus | null {
  const rawStatus = payload.status?.status?.trim() ?? ''
  const lower = rawStatus.toLowerCase()
  const detailParts = [rawStatus, payload.error?.trim()].filter((part): part is string => !!part)
  const detail = detailParts.length ? detailParts.join(': ').slice(0, 500) : null

  switch (payload.eventType) {
    case 'new_document':
      return {
        eventCode: 'new_document',
        normalizedStatus: 'submission_accepted',
        isTerminal: false,
        detail,
      }
    case 'document_delivery': {
      if (/reject|refus|denied/.test(lower)) {
        return { eventCode: 'document_delivery', normalizedStatus: 'business_rejected', isTerminal: true, detail }
      }
      if (/accept|approv|\bpaid\b/.test(lower)) {
        return { eventCode: 'document_delivery', normalizedStatus: 'business_accepted', isTerminal: true, detail }
      }
      if (/acknowledg|\back\b|confirmed/.test(lower)) {
        return { eventCode: 'document_delivery', normalizedStatus: 'recipient_acknowledged', isTerminal: false, detail }
      }
      if (/processed|delivered|sent|transport|success|complete|received/.test(lower)) {
        return { eventCode: 'document_delivery', normalizedStatus: 'transport_succeeded', isTerminal: false, detail }
      }
      if (/error|fail|undeliver|bounce/.test(lower)) {
        return { eventCode: 'document_delivery', normalizedStatus: 'retryable_failure', isTerminal: false, detail }
      }
      return { eventCode: 'document_delivery', normalizedStatus: 'submission_accepted', isTerminal: false, detail }
    }
    case 'document_error': {
      const reason = `${rawStatus} ${payload.error ?? ''}`
      // Qvalia retries transport errors for 24 h by default and then sends a
      // document_delivery if it succeeds; only structural rejections are final.
      const permanent = PERMANENT_ERROR_RE.test(reason)
      return {
        eventCode: 'document_error',
        normalizedStatus: permanent ? 'failed' : 'retryable_failure',
        isTerminal: permanent,
        detail,
      }
    }
    default:
      return null
  }
}

function shapeOf(value: unknown): string {
  if (value === null) return 'null'
  return Array.isArray(value) ? 'array' : typeof value
}

/** `detail` names the shape (types, or Qvalia's own status value), never document content. */
function upstreamShapeError(detail: string): QvaliaApiError {
  return new QvaliaApiError('shape', 'Qvalia answered in a shape this adapter does not know', { detail })
}

export interface QvaliaOutgoingStatus {
  /** Qvalia's value as sent (e.g. `processed`); null while the message has no outcome. */
  status: string | null
  updatedAt: string | null
}

/**
 * Read one record of `/invoices/outgoing/status`. `metadata.status` is the
 * documented string or, as the endpoint actually answers (sandbox,
 * 2026-09-29), the message-log object:
 *   accepted: { event: 'message-log/create', updatedAt, deliveryMethod }
 *   outcome:  { event: 'message-log/update', status: 'processed', updatedAt, deliveryMethod }
 * and `metadata` is `{}` while the message log has no entry. `updatedAt`
 * comes from the object, else `metadata`, else the record. Any other shape
 * throws a non-retryable `shape` error instead of being skipped: a skipped
 * record is a delivery outcome lost without a trace.
 */
export function readQvaliaOutgoingStatus(record: unknown): QvaliaOutgoingStatus {
  const item = asRecord(record)
  if (!item) throw upstreamShapeError(`status record is ${shapeOf(record)}`)
  const metadata = asRecord(item.metadata)
  if (!metadata) throw upstreamShapeError(`status record metadata is ${shapeOf(item.metadata)}`)
  const updatedAt = asString(metadata.updatedAt) ?? asString(item.updatedAt)
  const raw = metadata.status
  if (raw === undefined) return { status: null, updatedAt }
  if (typeof raw === 'string') return { status: raw, updatedAt }
  const logStatus = asRecord(raw)
  if (!logStatus) throw upstreamShapeError(`metadata.status is ${shapeOf(raw)}`)
  const logUpdatedAt = asString(logStatus.updatedAt) ?? updatedAt
  const value = logStatus.status
  if (value === undefined) return { status: null, updatedAt: logUpdatedAt }
  if (typeof value !== 'string') throw upstreamShapeError(`metadata.status.status is ${shapeOf(value)}`)
  return { status: value, updatedAt: logUpdatedAt }
}

/**
 * Qvalia's documented outgoing statuses (api.qvalia.io), compared without
 * case or surrounding space. `processed`, `processed_with_warning` and
 * `error` are final at Qvalia; `pending`, `delayed` and `warning` are not and
 * yield no event, nor does a message without an outcome (null). A delivered
 * message is `transport_succeeded`, not terminal for Accounted (a business
 * response may follow); `error` is final at Qvalia, so it is `failed`. Any
 * other value throws instead of being guessed from its wording.
 */
export function mapQvaliaOutgoingStatus(
  status: string | null,
): Pick<QvaliaNormalizedStatus, 'normalizedStatus' | 'isTerminal'> | null {
  if (status === null) return null
  const value = status.trim().toLowerCase()
  switch (value) {
    case 'pending':
    case 'delayed':
    case 'warning':
      return null
    case 'processed':
    case 'processed_with_warning':
      return { normalizedStatus: 'transport_succeeded', isTerminal: false }
    case 'error':
      return { normalizedStatus: 'failed', isTerminal: true }
    default:
      throw upstreamShapeError(`undocumented outgoing status ${JSON.stringify(value.slice(0, 40))}`)
  }
}

/**
 * The records of an `/invoices/outgoing/status` answer, `{ status, data: [record] }`.
 * An empty `data` is no record (like the 204 for an unknown integrationId);
 * an answer without a `data` array is a shape this adapter does not know.
 */
function outgoingStatusRecords(json: unknown, text: string): unknown[] {
  const envelope = asRecord(json)
  if (envelope && Array.isArray(envelope.data)) return envelope.data
  const found = envelope
    ? `data: ${shapeOf(envelope.data)}`
    : !text.trim() ? 'empty body' : json === null ? 'non-JSON body' : `${shapeOf(json)} body`
  throw upstreamShapeError(`status answer without a data array (${found})`)
}

/**
 * Qvalia's lookup returns document types as SMP service URLs, e.g.
 * `https://smp-test.qvalia.com/iso6523-actorid-upis::0007:5567321707/services/busdox-docid-qns::urn:oasis:...::2.1`
 * (verified live 2026-08-21), sometimes percent-encoded. Reduce them to the
 * bare Peppol document type identifier so capabilities compare by value.
 */
export function normalizePeppolDocumentTypeId(value: string): string {
  let candidate = value.trim()
  const servicesIndex = candidate.indexOf('/services/')
  if (/^https?:\/\//i.test(candidate) && servicesIndex !== -1) {
    candidate = candidate.slice(servicesIndex + '/services/'.length)
  }
  try {
    candidate = decodeURIComponent(candidate)
  } catch {
    // keep as-is when not percent-encoded
  }
  const schemeMatch = /^(busdox-docid-qns|peppol-doctype-wildcard)::/.exec(candidate)
  if (schemeMatch) candidate = candidate.slice(schemeMatch[0].length)
  return candidate
}

function capabilityFromDocType(value: string): PeppolRecipientCapability {
  const documentTypeId = normalizePeppolDocumentTypeId(value)
  return {
    documentTypeId,
    processId: documentTypeId === PEPPOL_BIS_BILLING_INVOICE_DOCUMENT_TYPE_ID ? PEPPOL_BIS_BILLING_PROFILE_ID : '',
  }
}

export function createQvaliaTransport(
  config: QvaliaConfig,
  deps: QvaliaTransportDeps = {},
): PeppolTransport {
  const fetchImpl = deps.fetch ?? globalThis.fetch
  const now = deps.now ?? (() => new Date())
  const partner = encodePathSegment(config.partnerRegNo)
  const account = encodePathSegment(config.accountRegNo)
  const transactionBase = `${config.baseUrl}/partner/${partner}/transaction/${account}`
  // The account every document is sent from (QVALIA_ACCOUNT_REG_NO, else the
  // partner number) is the tenant label of every delivery and event this
  // adapter makes (PeppolTransport.tenantId).
  const tenantId = config.accountRegNo

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    init: { headers?: Record<string, string>; body?: string } = {},
  ): Promise<Response> {
    try {
      return await fetchImpl(url, {
        method,
        headers: {
          Authorization: authorizationHeader(config),
          accept: 'application/json',
          ...init.headers,
        },
        body: init.body,
        cache: 'no-store',
      })
    } catch (error) {
      throw new QvaliaApiError('network', 'Could not reach Qvalia', { cause: error })
    }
  }

  async function lookupRecipient(participant: PeppolParticipant): Promise<PeppolRecipientLookup> {
    const checkedAt = now().toISOString()
    const peppolId = `${participant.scheme}:${participant.identifier}`
    const url = `${config.baseUrl}/partner/${partner}/peppol/lookup/${encodePathSegment(peppolId)}?docTypeRoot=Invoice`
    const response = await request('GET', url)

    if (response.status === 204 || response.status === 404) {
      return { reachable: false, participant, reasonCode: 'participant_not_found', checkedAt }
    }
    const { text, json } = await readBody(response)
    if (response.status === 422 || response.status === 400) {
      return { reachable: false, participant, reasonCode: 'invalid_identifier', checkedAt }
    }
    if (!response.ok) throw classifyHttpFailure(response.status, json, text)

    const data = asRecord(asRecord(json)?.data) ?? asRecord(json)
    if (!data) {
      throw new QvaliaApiError('protocol', 'Qvalia lookup answered without a data object', {
        httpStatus: response.status,
      })
    }

    const exists = data.exists === true
    const rootDocTypeExists = data.rootDocTypeExists
    const matches = Array.isArray(data.matches) ? data.matches : []
    const capabilities: PeppolRecipientCapability[] = []
    for (const match of matches) {
      const docTypes = asRecord(match)?.docTypes
      if (!Array.isArray(docTypes)) continue
      for (const docType of docTypes) {
        const value = asString(asRecord(docType)?.value)
        if (value) capabilities.push(capabilityFromDocType(value))
      }
    }

    if (!exists) {
      return { reachable: false, participant, reasonCode: 'participant_not_registered', checkedAt }
    }
    if (rootDocTypeExists === false) {
      return { reachable: false, participant, reasonCode: 'document_type_not_supported', checkedAt }
    }
    return { reachable: true, participant, capabilities, checkedAt }
  }

  async function recoverDuplicateSubmission(
    submission: PeppolSubmission,
    duplicate: QvaliaApiError,
  ): Promise<PeppolSubmissionReceipt> {
    const documentId = extractUblDocumentId(submission.document)
    if (!documentId) throw duplicate

    const url = `${transactionBase}/invoices/outgoing?documentId=${encodeURIComponent(documentId)}&includeRead=true&limit=10`
    const response = await request('GET', url)
    const { json } = await readBody(response)
    if (!response.ok) throw duplicate

    const data = asRecord(json)?.data ?? json
    const messages = Array.isArray(data) ? data : data ? [data] : []
    for (const message of messages) {
      const integrationId = extractIntegrationId(message)
      const supplier = extractUblJsonSupplierEndpoint(message)
      if (!integrationId || !supplier) continue
      if (!participantsEqual(supplier, submission.sender)) continue
      return {
        provider: QVALIA_PROVIDER,
        providerSubmissionId: integrationId,
        idempotencyKey: submission.idempotencyKey,
        tenantReference: submission.tenantReference,
        acceptedAt: now().toISOString(),
      }
    }
    throw duplicate
  }

  async function submit(submission: PeppolSubmission): Promise<PeppolSubmissionReceipt> {
    if (submission.contentType !== 'application/xml') {
      throw new QvaliaApiError('rejected', 'Qvalia adapter only submits UBL XML', {
        detail: `unsupported content type ${submission.contentType}`,
      })
    }
    // A resend after a failed delivery (replacesSubmissionId): with
    // `?overwrite=true` Qvalia sends the document again under a NEW
    // integrationId instead of answering 409 for the invoice number it holds
    // for this receiver (confirmed by Qvalia). A 409 is then never answered
    // by adopting an earlier integrationId: that is the failed submission
    // the resend replaces, already recorded on another delivery.
    const overwrite = submission.replacesSubmissionId ? '?overwrite=true' : ''
    const response = await request('POST', `${transactionBase}/invoices/outgoing${overwrite}`, {
      headers: { 'content-type': 'application/xml' },
      body: submission.document,
    })
    const { text, json } = await readBody(response)

    if (!response.ok) {
      const failure = classifyHttpFailure(response.status, json, text)
      if (failure.kind === 'duplicate' && !submission.replacesSubmissionId) {
        return recoverDuplicateSubmission(submission, failure)
      }
      throw failure
    }

    const data = asRecord(asRecord(json)?.data)
    const integrationId = asString(data?.integrationId)
      ?? asString(response.headers.get('integrationid'))
    if (!integrationId) {
      throw new QvaliaApiError('protocol', 'Qvalia accepted the document without an integrationId', {
        httpStatus: response.status,
        detail: text.trim().slice(0, 500) || null,
      })
    }

    return {
      provider: QVALIA_PROVIDER,
      providerSubmissionId: integrationId,
      idempotencyKey: submission.idempotencyKey,
      tenantReference: submission.tenantReference,
      acceptedAt: now().toISOString(),
    }
  }

  function webhookAuthorized(headers: Headers): boolean {
    if (!config.webhookSecret) return false
    const presented = headers.get(config.webhookHeader)
    if (!presented) return false
    const a = Buffer.from(presented)
    const b = Buffer.from(config.webhookSecret)
    return a.length === b.length && timingSafeEqual(a, b)
  }

  /**
   * ADA CASA 7.2: HMAC-SHA256 over `<t>.<raw body bytes>`, compared
   * timing-safe, with the signed `t` inside a 5-minute window. Replays inside
   * the window are absorbed by the event dedupe key.
   */
  function webhookSignatureValid(webhook: PeppolWebhookRequest, signingSecret: string): void {
    const check = verifySignatureHeader({
      header: webhook.headers.get(QVALIA_SIGNATURE_HEADER),
      rawBody: webhook.rawBody,
      secret: signingSecret,
      toleranceSeconds: QVALIA_SIGNATURE_TOLERANCE_SECONDS,
      nowSeconds: Math.floor(now().getTime() / 1000),
    })
    if (!check.ok) {
      throw new QvaliaApiError('auth', `Qvalia webhook signature rejected: ${check.reason}`)
    }
  }

  async function verifyWebhook(webhook: PeppolWebhookRequest): Promise<PeppolVerifiedEvent[]> {
    const signingSecret = config.webhookSigningSecret ?? null
    if (signingSecret) {
      webhookSignatureValid(webhook, signingSecret)
    } else if (!webhookAuthorized(webhook.headers)) {
      throw new QvaliaApiError('auth', 'Qvalia webhook secret missing or mismatched')
    }
    const verificationMethod = signingSecret ? 'hmac_sha256_signature' : 'shared_secret_header'

    let parsed: unknown
    try {
      parsed = JSON.parse(Buffer.from(webhook.rawBody).toString('utf8'))
    } catch (error) {
      throw new QvaliaApiError('protocol', 'Qvalia webhook body is not JSON', { cause: error })
    }
    const payloads = Array.isArray(parsed) ? parsed : [parsed]
    const eventSha256 = sha256Hex(webhook.rawBody)
    const events: PeppolVerifiedEvent[] = []

    for (const [index, candidate] of payloads.entries()) {
      const payload = asRecord(candidate) as QvaliaWebhookPayload | null
      if (!payload || typeof payload.eventType !== 'string') continue
      // Inbound documents are a separate flow; this boundary is outbound-only.
      if (payload.direction && payload.direction !== 'outgoing') continue
      const normalized = normalizeQvaliaWebhook(payload)
      if (!normalized) continue

      const integrationId = asString(payload.integrationId) ?? asString(payload.globalTransactionId)
      const transactionId = asString(payload.globalTransactionId) ?? integrationId ?? 'unknown'
      const statusKey = payload.status?.status ?? payload.status?.event ?? normalized.eventCode
      const occurredAt = asString(payload.status?.updatedAt) ?? asString(payload.occurredAt) ?? now().toISOString()

      events.push({
        provider: QVALIA_PROVIDER,
        // The adapter's label, like the poll: the delivery row carries it and
        // the lifecycle RPC refuses any other. The payload's own
        // accountRegNo stays in rawPayload.
        providerTenantId: tenantId,
        providerSubmissionId: integrationId,
        providerEventId: `${payload.eventType}:${transactionId}:${statusKey}`,
        idempotencyKey: null,
        eventCode: normalized.eventCode,
        normalizedStatus: normalized.normalizedStatus,
        isTerminal: normalized.isTerminal,
        detail: normalized.detail,
        occurredAt,
        rawPayload: payload as unknown as Record<string, unknown>,
        eventSha256: payloads.length === 1 ? eventSha256 : sha256Hex(`${eventSha256}:${index}`),
        verificationMethod,
      })
    }

    return events
  }

  async function retrieveEvidence(providerSubmissionId: string): Promise<PeppolDeliveryEvidence[]> {
    const retrievedAt = now().toISOString()
    const query = `integrationId=${encodeURIComponent(providerSubmissionId)}&includeRead=true&limit=1`

    const statusResponse = await request('GET', `${transactionBase}/invoices/outgoing/status?${query}`)
    const statusBody = await readBody(statusResponse)
    if (!statusResponse.ok && statusResponse.status !== 204) {
      throw classifyHttpFailure(statusResponse.status, statusBody.json, statusBody.text)
    }

    const documentResponse = await request('GET', `${transactionBase}/invoices/outgoing?${query}`, {
      headers: { accept: 'application/xml' },
    })
    const documentText = documentResponse.ok ? await documentResponse.text() : ''
    const exactDocument = documentText.trim().startsWith('<') ? documentText : null

    const payload: Record<string, unknown> = {
      integrationId: providerSubmissionId,
      status: statusBody.json ?? null,
      document_http_status: documentResponse.status,
      note: 'Provider-held copy of the submitted document and its latest message-log status.',
    }
    const exactDocumentSha256 = exactDocument ? sha256Hex(exactDocument) : null

    return [{
      provider: QVALIA_PROVIDER,
      evidenceType: 'qvalia_message_record',
      payload,
      exactDocument,
      exactDocumentSha256,
      evidenceSha256: sha256Hex(JSON.stringify({ payload, exactDocumentSha256 })),
      retrievedAt,
    }]
  }

  // ---- receiving side -------------------------------------------------

  async function registerRecipient(input: PeppolRecipientRegistrationInput): Promise<PeppolRecipientRegistration> {
    const peppolId = `${input.participant.scheme}:${input.participant.identifier}`
    const url = `${config.baseUrl}/partner/${partner}/account/${account}/peppol/${encodePathSegment(peppolId)}`
    const body = {
      description: input.description ?? `Accounted: ${input.businessCard.companyName}`,
      businessCard: {
        companyName: input.businessCard.companyName,
        countryCode: input.businessCard.countryCode,
        geographicalInformation: input.businessCard.geographicalInformation ?? '',
        VAT: input.businessCard.vatNumber ?? '',
        orgNr: input.businessCard.orgNumber ?? '',
        suffix: '',
      },
      docTypes: input.documentTypes.map((type) => ({ profile: type.processId, document: type.documentTypeId })),
    }
    const response = await request('PUT', url, {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const { text, json } = await readBody(response)
    if (!response.ok) throw classifyHttpFailure(response.status, json, text)
    const record = asRecord(json)
    const status = asString(record?.status)
    return {
      status: status === 'updated' ? 'updated' : 'registered',
      participant: input.participant,
      providerAccountReference: config.accountRegNo,
      raw: record ?? {},
    }
  }

  async function unregisterRecipient(participant: PeppolParticipant): Promise<void> {
    const peppolId = `${participant.scheme}:${participant.identifier}`
    const url = `${config.baseUrl}/partner/${partner}/account/${account}/peppol/${encodePathSegment(peppolId)}`
    const response = await request('DELETE', url)
    if (response.status === 404 || response.status === 204) return
    const { text, json } = await readBody(response)
    if (!response.ok) throw classifyHttpFailure(response.status, json, text)
  }

  function inboundPath(documentType: PeppolInboundDocumentType): { collection: string; read: string } {
    return documentType === 'CreditNote'
      ? { collection: 'creditnotes', read: 'readcreditnotes' }
      : { collection: 'invoices', read: 'readinvoices' }
  }

  async function listInboundDocuments(options: PeppolInboundListOptions): Promise<PeppolInboundMessage[]> {
    const { collection, read } = inboundPath(options.documentType)
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100)
    // The "read" endpoint returns only documents not yet handed over and marks
    // them read; the plain endpoint with includeRead=true re-syncs everything.
    const url = options.includeRead
      ? `${transactionBase}/${collection}/incoming?includeRead=true&limit=${limit}`
      : `${transactionBase}/${collection}/incoming/${read}?limit=${limit}`
    const response = await request('GET', url)
    if (response.status === 204) return []
    const { text, json } = await readBody(response)
    if (!response.ok) throw classifyHttpFailure(response.status, json, text)
    const data = asRecord(json)?.data ?? json
    const items = Array.isArray(data) ? data : data ? [data] : []
    const messages: PeppolInboundMessage[] = []
    for (const item of items) {
      const record = asRecord(item)
      const integrationId = extractIntegrationId(record)
      if (!record || !integrationId) continue
      messages.push({
        provider: QVALIA_PROVIDER,
        providerDocumentId: integrationId,
        documentType: options.documentType,
        payload: record,
        receivedAt: asString(record.createdAt) ?? asString(record.created_at) ?? null,
      })
    }
    return messages
  }

  async function fetchInboundDocumentXml(
    providerDocumentId: string,
    documentType: PeppolInboundDocumentType,
  ): Promise<string | null> {
    const { collection } = inboundPath(documentType)
    const url = `${transactionBase}/${collection}/incoming?integrationId=${encodeURIComponent(providerDocumentId)}&includeRead=true&limit=1`
    const response = await request('GET', url, { headers: { accept: 'application/xml' } })
    if (response.status === 204 || response.status === 404) return null
    const text = await response.text()
    if (!response.ok) throw classifyHttpFailure(response.status, null, text)
    return text.trim().startsWith('<') ? text : null
  }

  /**
   * Outbound status by polling `/invoices/outgoing/status`. The record is read
   * by readQvaliaOutgoingStatus (the message-log object the endpoint answers
   * with) and mapped by mapQvaliaOutgoingStatus (Qvalia's documented values;
   * the webhook's free-text mapping is not used here). No event while the
   * message has no outcome or a non-final one, for an empty `data` and for a
   * 204/404; an unknown shape or value throws PEPPOL_UPSTREAM_SHAPE_CODE.
   */
  async function pollDeliveryStatus(providerSubmissionId: string): Promise<PeppolVerifiedEvent[]> {
    const url = `${transactionBase}/invoices/outgoing/status?integrationId=${encodeURIComponent(providerSubmissionId)}&includeRead=true&limit=1`
    const response = await request('GET', url)
    if (response.status === 204 || response.status === 404) return []
    const { text, json } = await readBody(response)
    if (!response.ok) throw classifyHttpFailure(response.status, json, text)
    const events: PeppolVerifiedEvent[] = []
    for (const record of outgoingStatusRecords(json, text)) {
      const { status, updatedAt } = readQvaliaOutgoingStatus(record)
      const mapped = mapQvaliaOutgoingStatus(status)
      if (!status || !mapped) continue
      events.push({
        provider: QVALIA_PROVIDER,
        providerTenantId: tenantId,
        providerSubmissionId,
        // Same dedupe key as the webhook would use for this transition, so a
        // later webhook for the same status is a harmless duplicate.
        providerEventId: `document_delivery:${providerSubmissionId}:${status}`,
        idempotencyKey: null,
        eventCode: 'status_poll',
        normalizedStatus: mapped.normalizedStatus,
        isTerminal: mapped.isTerminal,
        detail: status.slice(0, 500),
        occurredAt: updatedAt ?? now().toISOString(),
        rawPayload: asRecord(record) ?? {},
        // The transition, not the answer's bytes: the same status at the same
        // time is one event however often it is polled.
        eventSha256: sha256Hex(`${providerSubmissionId}:${status}:${updatedAt ?? ''}`),
        verificationMethod: 'provider_poll',
      })
    }
    return events
  }

  return {
    provider: QVALIA_PROVIDER,
    tenantId,
    lookupRecipient,
    submit,
    verifyWebhook,
    retrieveEvidence,
    registerRecipient,
    unregisterRecipient,
    listInboundDocuments,
    fetchInboundDocumentXml,
    pollDeliveryStatus,
  }
}
