import { z } from 'zod'

/**
 * @accounted/connect-contract
 *
 * The wire contract between an Accounted ledger installation (hosted, or a
 * self-hosted instance) and the Accounted Connect service that operates the
 * provider integrations only Accounted can run: bank feeds through its PSD2
 * credentials, the Skatteverket API client, the Peppol access point, company
 * lookup, the migration sources.
 *
 * Everything here is shape, never behaviour: constants, Zod schemas and the
 * TypeScript types inferred from them, plus the one normalizer that keeps a
 * provider field on that shape (normalizeBankTransactionCode). Both sides
 * validate with the same schemas so they cannot drift apart. The package is MIT so that anyone may
 * implement either side of it: a self-hosted ledger talking to Accounted
 * Connect, or an alternative connector service talking to the open ledger.
 *
 * Versioning: `CONTRACT_VERSION` is a date. Fields are only ever added; a
 * breaking change is a new operation or family name, never a changed one.
 */

export const CONTRACT_VERSION = '2026-09-29'

// ---------------------------------------------------------------------------
// Keys, headers and paths
// ---------------------------------------------------------------------------

/** Connector keys start with this prefix; the rest is 32 random bytes, base64url. */
export const CONNECTOR_KEY_PREFIX = 'gnubok_ck_'

/** Header alternative to `Authorization: Bearer`, for proxied calls where Authorization carries an upstream token. */
export const CONNECTOR_KEY_HEADER = 'x-connector-key'

export const CONNECTOR_ENTITLEMENTS_PATH = '/api/connect/entitlements'

/** Default origin of the connector service. Installations that pointed at the hosted app's copy of the routes set GNUBOK_CONNECT_URL explicitly. */
export const DEFAULT_CONNECT_BASE_URL = 'https://connect.accounted.se'

/**
 * Request headers an installation sends alongside its key. The company header
 * is the installation's own opaque company reference: the service never
 * resolves it to anything and only uses it to scope quotas and ownership.
 */
export const CONNECTOR_HEADERS = {
  company: 'X-Connector-Company',
  upstreamAuthorization: 'X-Connector-Upstream-Authorization',
  upstreamContentType: 'X-Connector-Upstream-Content-Type',
} as const

// ---------------------------------------------------------------------------
// Entitlements (installation <-> service)
// ---------------------------------------------------------------------------

export const connectorKeyStatusSchema = z.enum(['active', 'suspended', 'revoked'])
export type ConnectorKeyStatus = z.infer<typeof connectorKeyStatusSchema>

/** What the service tells an installation about its key. */
export const connectorEntitlementsSchema = z.object({
  status: connectorKeyStatusSchema,
  /** Capability keys the subscription covers. */
  scopes: z.array(z.string()),
  /** End of the paid period, ISO; null for an open-ended (manually issued) key. */
  current_period_end: z.string().nullable(),
  org_number: z.string(),
  /** The installation origin this key is pinned to; null until the first sync claims it. */
  instance_url: z.string().nullable(),
  server_time: z.string(),
})
export type ConnectorEntitlements = z.infer<typeof connectorEntitlementsSchema>

/** What an installation reports on every sync (quantity billing input). */
export const connectorSyncReportSchema = z.object({
  active_company_count: z.number().int().min(0),
  instance_url: z.string().optional(),
  app_version: z.string().optional(),
})
export type ConnectorSyncReport = z.infer<typeof connectorSyncReportSchema>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every refusal from the service is this shape. `code` is stable and machine
 * readable; `retryable` tells the installation whether backing off helps.
 */
export const connectorErrorSchema = z.object({
  error: z.string(),
  code: z.string(),
  retryable: z.boolean().optional(),
  detail: z.string().nullable().optional(),
})
export type ConnectorError = z.infer<typeof connectorErrorSchema>

/** Codes the service may answer with, in addition to upstream-specific ones. */
export const CONNECTOR_ERROR_CODES = [
  'BAD_REQUEST',
  'CONNECTOR_SCOPE_MISSING',
  'CONNECTOR_COMPANY_MISSING',
  'CONNECTOR_PATH_NOT_ALLOWED',
  'CONNECTOR_NOT_OWNED',
  'CONNECTOR_QUOTA_EXCEEDED',
  'CONNECTOR_RATE_LIMITED',
  'CONNECTOR_STATE_INVALID',
  'CONNECTOR_STATE_CONSUMED',
  'CONNECTOR_REDIRECT_INVALID',
  'CONNECTOR_LEDGER_FAILED',
  'CONNECTOR_UPSTREAM_ERROR',
  'CONNECTOR_UPSTREAM_UNCONFIGURED',
  // The access point answered in a shape the service does not understand; not retryable.
  'CONNECTOR_UPSTREAM_SHAPE',
  'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN',
  'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
  'CONNECTOR_PEPPOL_PARTICIPANT_PUBLISHED_ELSEWHERE',
  'CONNECTOR_PEPPOL_REGISTRATION_IN_PROGRESS',
  'CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED',
  // A resend (replacesSubmissionId) of a submission the access point has not
  // reported as failed: nothing is sent, so a delivered invoice is never sent twice.
  'CONNECTOR_PEPPOL_RESEND_NOT_FAILED',
  'PEPPOL_RECEIVING_UNSUPPORTED',
  'PEPPOL_REGISTRATION_CAP_REACHED',
  // The access point already holds an invoice with this number for this
  // receiver; resend only with replacesSubmissionId.
  'PEPPOL_DUPLICATE_INVOICE_NUMBER',
] as const
export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// Bank sync operation (installation -> service, POST /api/connect/bank/sync)
// ---------------------------------------------------------------------------

/**
 * The installation holds the PSD2 session and the account; the service does
 * the provider paging, the booked-only filter and the normalization, and
 * returns what the installation ingests plus the raw provider pages it
 * archives. Stored keys (external ids) stay computed on the installation from
 * booking_date, amount and its own account scope, exactly as before.
 */
export const bankSyncRequestSchema = z.object({
  /** The Enable Banking session id the installation obtained (ownership is checked). */
  session_id: z.string().trim().min(1).max(200),
  account_uid: z.string().trim().min(1).max(200),
  account_currency: z.string().trim().length(3),
  date_from: z.iso.date().optional(),
  date_to: z.iso.date().optional(),
  strategy: z.enum(['default', 'longest']).optional(),
})
export type BankSyncRequest = z.infer<typeof bankSyncRequestSchema>

export const normalizedBankTransactionSchema = z.object({
  /** A real calendar date: the installation's stored keys and ledger date derive from it. */
  booking_date: z.iso.date(),
  amount: z.number(),
  currency: z.string(),
  description: z.string(),
  counterparty_name: z.string().nullable(),
  counterparty_account: z.string().nullable(),
  reference: z.string().nullable(),
  merchant_category_code: z.string().nullable(),
  bank_transaction_code: z.string().nullable(),
  proprietary_bank_transaction_code: z.string().nullable(),
})
export type NormalizedBankTransaction = z.infer<typeof normalizedBankTransactionSchema>

/**
 * Enable Banking sends `bank_transaction_code` (and, in principle,
 * `proprietary_bank_transaction_code`) as an object
 * `{ description, code, sub_code }`, not as the string both sides declared.
 * Swedish ASPSPs leave `code` null and put the only signal in `description`
 * ("Card purchase", "Swish", "Kortköp/uttag"). The wire field is a string, so
 * every producer (the Connect service and a ledger's direct Enable Banking
 * path) flattens with this one rule before the value reaches
 * `normalizedBankTransactionSchema` or a ledger column:
 *
 *   object with `code`  -> `code`, or `code/sub_code` when a sub-code exists
 *   object without code -> `description`
 *   string              -> trimmed as is
 *   anything else       -> null
 *
 * Shared here rather than copied per producer so the two sides cannot drift:
 * the 2026-09-03 outage was exactly that drift (Connect forwarded the object,
 * the ledger rejected it, and the direct path had been storing the object's
 * JSON text since 2026-08-09).
 */
export function normalizeBankTransactionCode(input: unknown): string | null {
  if (typeof input === 'string') {
    const trimmed = input.trim()
    return trimmed.length > 0 ? trimmed : null
  }
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const record = input as Record<string, unknown>
    const text = (key: string): string | null => {
      const value = record[key]
      if (typeof value !== 'string') return null
      const trimmed = value.trim()
      return trimmed.length > 0 ? trimmed : null
    }
    const code = text('code')
    if (code) {
      const subCode = text('sub_code')
      return subCode ? `${code}/${subCode}` : code
    }
    return text('description')
  }
  return null
}

export const bankSyncResponseSchema = z.object({
  transactions: z.array(normalizedBankTransactionSchema),
  /** Raw provider pages, verbatim, for the installation's archive. */
  raw_pages: z.array(z.string()),
  skipped_pending: z.number().int().min(0),
  returned_min_booking_date: z.string().nullable(),
  returned_max_booking_date: z.string().nullable(),
  /** Set when the provider rejected the window and a narrower date_from was used. */
  effective_date_from: z.string().nullable(),
  pages: z.number().int().min(0),
})
export type BankSyncResponse = z.infer<typeof bankSyncResponseSchema>

/**
 * Error codes specific to the bank sync operation. CONNECTOR_BANK_RATE_LIMITED
 * is the BANK's 429 (not the service's own budget, CONNECTOR_RATE_LIMITED):
 * answered with HTTP 429 and the bank's Retry-After header when it sent one.
 */
export const BANK_SYNC_ERROR_CODES = [
  'CONNECTOR_BANK_SESSION_EXPIRED',
  'CONNECTOR_BANK_UPSTREAM_ERROR',
  'CONNECTOR_BANK_RATE_LIMITED',
] as const

// ---------------------------------------------------------------------------
// POS sales (installation -> service, /api/connect/pos/*)
// ---------------------------------------------------------------------------

/**
 * Point-of-sale sales per business day, the input of the daily takings
 * voucher (gemensam verifikation, BFL 5 kap 6 §). One provider-neutral
 * family; which providers exist is answered at runtime (`venues` lists them),
 * never named here. Conventions:
 *
 * - The service holds the integrator credential a POS provider issued to
 *   Accounted. A venue is reachable only when the provider has opened it for
 *   that credential AND Arcim has granted it to the calling key for the
 *   organisation the provider named: the installation never types a venue
 *   id, it picks one of the venues `venues` lists for its company's
 *   organisation number.
 * - Every call carries X-Connector-Company. `day` and `disconnect` also carry
 *   the handle `connect` returned, in POS_CONNECTION_HEADER; the service keeps
 *   only its hash and refuses a handle bound to another key or company
 *   (CONNECTOR_CONNECTION_NOT_OWNED).
 * - Amounts are numbers in `currency`, rounded to two decimals by the
 *   service. Sums are signed: a refund reduces sales and tenders.
 * - `day` answers with the service's model of the day plus the provider's
 *   answer verbatim (`raw`), which the installation archives (BFL 7 kap) and
 *   never parses. Provider quirks are resolved by the service and, where it
 *   had to assume something, reported in `issues` for a person to check.
 * - Reads only: nothing in this family writes at the provider.
 */
export const POS_SALES_BASE_PATH = '/api/connect/pos'

/** The connector key scope that opens this family. */
export const POS_SALES_SCOPE = 'pos_sales'

/** The connection handle header; the same name the provider-capability families use. */
export const POS_CONNECTION_HEADER = 'X-Connector-Connection'

/** In characters: the provider's answer for one day, verbatim. Response bodies are capped at 4.5 MB. */
export const POS_MAX_RAW_CHARS = 3_000_000

const posOrgNumberSchema = z.string().regex(/^\d{10}$/, 'ten digits, no dash')
const posRefSchema = z.string().trim().min(1).max(64)
const posAmountSchema = z.number().finite()
const posHttpsUrlSchema = z.url({ protocol: /^https$/, hostname: z.regexes.domain })

/** A POS provider as the installation shows it. Field names follow the catalogue's provider profile. */
export const posProviderSchema = z.object({
  /** Stable opaque slug; the installation stores it on its connection. */
  ref: posRefSchema,
  displayName: z.string().trim().min(1).max(80),
  legalName: z.string().trim().min(1).max(200).nullable(),
  portalUrl: posHttpsUrlSchema.nullable(),
  supportUrl: posHttpsUrlSchema.nullable(),
  /**
   * How the customer asks the provider to open a venue for Accounted, in
   * Swedish, shown when no venue is listed yet. Null when no request is needed.
   */
  accessRequestSv: z.string().max(4000).nullable(),
})
export type PosProvider = z.infer<typeof posProviderSchema>

export const posVenueSchema = z.object({
  provider: posProviderSchema,
  /** The provider's own, non-secret venue id. */
  venueRef: posRefSchema,
  name: z.string().trim().min(1).max(200),
  /** True when this company holds the venue now. */
  connected: z.boolean(),
  /** False when another company on this key holds it. */
  available: z.boolean(),
})
export type PosVenue = z.infer<typeof posVenueSchema>

export const posVenuesRequestSchema = z.object({ orgNumber: posOrgNumberSchema })
export type PosVenuesRequest = z.infer<typeof posVenuesRequestSchema>

export const posVenuesResponseSchema = z.object({
  /** Venues granted to this key for the organisation number. */
  venues: z.array(posVenueSchema),
  /** Providers this key may use, so the installation can explain how to get a venue opened. */
  providers: z.array(posProviderSchema),
  serverTime: z.string(),
})
export type PosVenuesResponse = z.infer<typeof posVenuesResponseSchema>

export const posConnectRequestSchema = z.object({
  provider: posRefSchema,
  venueRef: posRefSchema,
  orgNumber: posOrgNumberSchema,
})
export type PosConnectRequest = z.infer<typeof posConnectRequestSchema>

export const posConnectionSchema = z.object({
  /** Opaque and secret-free; the installation stores it and sends it as POS_CONNECTION_HEADER. A new connect rotates it. */
  connectionHandle: z.string().min(16).max(256),
  provider: posProviderSchema,
  venueRef: posRefSchema,
  venueName: z.string().trim().min(1).max(200),
  connectedAt: z.string(),
})
export type PosConnection = z.infer<typeof posConnectionSchema>

/**
 * How a payment was made. `method` on a tender keeps the provider's own
 * word; `kind` is what the installation maps to an account. A provider word
 * the service does not recognise is `other`, with an issue.
 */
export const POS_TENDER_KINDS = ['card', 'swish', 'cash', 'gift_card', 'invoice', 'prepaid', 'other'] as const
export const posTenderKindSchema = z.enum(POS_TENDER_KINDS)
export type PosTenderKind = z.infer<typeof posTenderKindSchema>

export const posVatGroupSchema = z.object({
  /** In percent: 25, 12, 6 or 0 in Sweden today. A list keyed by rate, so a new rate needs no new field. */
  ratePercent: z.number().min(0).max(100),
  net: posAmountSchema,
  vat: posAmountSchema,
  gross: posAmountSchema,
})
export type PosVatGroup = z.infer<typeof posVatGroupSchema>

export const posTenderSchema = z.object({
  kind: posTenderKindSchema,
  method: z.string().max(64),
  /** Money received through this tender, tips included, refunds deducted. */
  amount: posAmountSchema,
  /** The tips inside `amount`. */
  tips: posAmountSchema,
  receiptCount: z.number().int().min(0),
})
export type PosTender = z.infer<typeof posTenderSchema>

export const posReceiptSchema = z.object({
  /** The receipt number as printed. */
  number: z.string().max(64),
  kind: z.enum(['sale', 'refund']),
  /** As the provider states it; may carry no offset (local time at the venue). */
  paidAt: z.string().max(64).nullable(),
  /** The provider's method word, or `mixed` when one receipt used several. */
  method: z.string().max(64),
  gross: posAmountSchema,
  tips: posAmountSchema,
})
export type PosReceipt = z.infer<typeof posReceiptSchema>

export const posIssueSchema = z.object({
  /** Stable, machine readable; the installation decides which codes block booking. */
  code: z.string().trim().min(1).max(64),
  message: z.string().max(500),
})
export type PosIssue = z.infer<typeof posIssueSchema>

/**
 * One business day as the provider closed it. Invariants the service
 * guarantees: `sales.gross` equals the sum of `vatGroups[].gross`, and the
 * sum of `tenders[].amount` equals `sales.gross + tips`.
 */
export const posDaySchema = z.object({
  businessDate: z.iso.date(),
  currency: z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case'),
  /** Sales of the day, tips excluded, refunds and discounts deducted. */
  sales: z.object({ net: posAmountSchema, vat: posAmountSchema, gross: posAmountSchema }),
  vatGroups: z.array(posVatGroupSchema).max(20),
  tenders: z.array(posTenderSchema).max(50),
  tips: posAmountSchema,
  /** Discounts granted, VAT included. Already deducted from sales; for the report only. */
  discounts: posAmountSchema,
  /** Refunds made, VAT included, as a negative amount. Already deducted from sales; for the report only. */
  refunds: z.object({ count: z.number().int().min(0), gross: posAmountSchema }),
  receiptCount: z.number().int().min(0),
  firstReceiptNumber: z.string().max(64).nullable(),
  lastReceiptNumber: z.string().max(64).nullable(),
  firstPaidAt: z.string().max(64).nullable(),
  lastPaidAt: z.string().max(64).nullable(),
  /** Sales per the provider's own article grouping, for the report only. */
  categories: z
    .array(z.object({ name: z.string().max(120), quantity: z.number().finite(), gross: posAmountSchema, vat: posAmountSchema }))
    .max(500),
  receipts: z.array(posReceiptSchema).max(10_000),
  issues: z.array(posIssueSchema).max(50),
})
export type PosDay = z.infer<typeof posDaySchema>

export const posDayRequestSchema = z.object({ businessDate: z.iso.date() })
export type PosDayRequest = z.infer<typeof posDayRequestSchema>

export const posDayResponseSchema = z.object({
  provider: posRefSchema,
  venueRef: posRefSchema,
  day: posDaySchema,
  /** The provider's answer verbatim, for the installation's archive. */
  raw: z.object({
    contentType: z.string().max(100),
    body: z.string().max(POS_MAX_RAW_CHARS),
    /** Lower-case hex sha256 of `body` as UTF-8. */
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  fetchedAt: z.string(),
})
export type PosDayResponse = z.infer<typeof posDayResponseSchema>

export const posDisconnectResponseSchema = z.object({ disconnected: z.literal(true) })

/**
 * The operation table, paths under POS_SALES_BASE_PATH. `connection` marks
 * the operations that carry POS_CONNECTION_HEADER.
 */
export const POS_SALES_OPERATIONS = {
  venues: { method: 'POST', path: '/venues', company: true, connection: false, request: posVenuesRequestSchema, response: posVenuesResponseSchema },
  connect: { method: 'POST', path: '/connect', company: true, connection: false, request: posConnectRequestSchema, response: posConnectionSchema },
  day: { method: 'POST', path: '/day', company: true, connection: true, request: posDayRequestSchema, response: posDayResponseSchema },
  disconnect: { method: 'POST', path: '/disconnect', company: true, connection: true, request: z.object({}), response: posDisconnectResponseSchema },
} as const
export type PosSalesOperation = keyof typeof POS_SALES_OPERATIONS

/**
 * Error codes of this family, in addition to the shared ones.
 * CONNECTOR_POS_PROVIDER_RATE_LIMITED is the PROVIDER's 429 (answered with its
 * Retry-After); CONNECTOR_POS_PROVIDER_ACCESS_DENIED means the provider has
 * not opened the venue or the operation for Accounted's credential, which a
 * person fixes by asking the provider.
 */
export const POS_SALES_ERROR_CODES = [
  'CONNECTOR_CONNECTION_NOT_OWNED',
  'CONNECTOR_POS_VENUE_NOT_GRANTED',
  'CONNECTOR_POS_VENUE_TAKEN',
  'CONNECTOR_POS_DAY_NOT_CLOSED',
  'CONNECTOR_POS_PROVIDER_ACCESS_DENIED',
  'CONNECTOR_POS_PROVIDER_RATE_LIMITED',
  'CONNECTOR_POS_PROVIDER_ERROR',
] as const
export type PosSalesErrorCode = (typeof POS_SALES_ERROR_CODES)[number]

// ---------------------------------------------------------------------------
// Peppol operations (installation -> service, /api/connect/peppol/*)
// ---------------------------------------------------------------------------

/**
 * The Peppol upstream speaks transport operations, not provider paths: the
 * access-point account is shared, so the service scopes every read to what
 * the calling key and company own. These schemas mirror the ledger's
 * PeppolTransport interface one to one.
 */

export const PEPPOL_MAX_DOCUMENT_CHARS = 5_000_000

const peppolFourDigitScheme = z
  .string()
  .length(4)
  .regex(/^\d+$/, 'ISO 6523 ICD scheme: four digits')

export const peppolParticipantSchema = z.object({
  scheme: peppolFourDigitScheme,
  identifier: z.string().trim().min(1).max(64),
})
export type PeppolParticipant = z.infer<typeof peppolParticipantSchema>

export const peppolDocumentTypeSchema = z.enum(['Invoice', 'CreditNote'])
export type PeppolInboundDocumentType = z.infer<typeof peppolDocumentTypeSchema>

export const peppolDeliveryStatusSchema = z.enum([
  'staged',
  'recipient_verified',
  'submitting',
  'retryable_failure',
  'submission_accepted',
  'transport_succeeded',
  'recipient_acknowledged',
  'business_accepted',
  'business_rejected',
  'no_route',
  'failed',
])
export type PeppolDeliveryStatus = z.infer<typeof peppolDeliveryStatusSchema>

export const peppolRecipientCapabilitySchema = z.object({
  documentTypeId: z.string(),
  processId: z.string(),
})

export const peppolLookupRequestSchema = z.object({ participant: peppolParticipantSchema })
export type PeppolLookupRequest = z.infer<typeof peppolLookupRequestSchema>

export const peppolLookupResultSchema = z.discriminatedUnion('reachable', [
  z.object({
    reachable: z.literal(true),
    participant: peppolParticipantSchema,
    capabilities: z.array(peppolRecipientCapabilitySchema),
    checkedAt: z.string(),
  }),
  z.object({
    reachable: z.literal(false),
    participant: peppolParticipantSchema,
    reasonCode: z.string(),
    checkedAt: z.string(),
  }),
])
export type PeppolLookupResult = z.infer<typeof peppolLookupResultSchema>

export const peppolSubmissionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(128),
  /** The installation's own company reference; the service overrides it with the company header. */
  tenantReference: z.string().trim().min(1).max(128),
  sender: peppolParticipantSchema,
  recipient: peppolParticipantSchema,
  documentTypeId: z.string().trim().min(1).max(512),
  processId: z.string().trim().min(1).max(512),
  filename: z.string().trim().min(1).max(255),
  contentType: z.literal('application/xml'),
  document: z.string().min(1).max(PEPPOL_MAX_DOCUMENT_CHARS),
  documentSha256: z.string().regex(/^[0-9a-f]{64}$/),
  /**
   * Resend after a failed delivery: the service submits with the access
   * point's overwrite and returns a NEW submission id. Only a submission
   * owned by the same key and company.
   */
  replacesSubmissionId: z.string().min(1).max(128).optional(),
})
export type PeppolSubmission = z.infer<typeof peppolSubmissionSchema>

export const peppolSubmissionReceiptSchema = z.object({
  provider: z.string(),
  providerSubmissionId: z.string(),
  idempotencyKey: z.string(),
  tenantReference: z.string(),
  acceptedAt: z.string(),
})
export type PeppolSubmissionReceipt = z.infer<typeof peppolSubmissionReceiptSchema>

export const peppolSubmissionRefSchema = z.object({
  providerSubmissionId: z.string().trim().min(1).max(128),
})
export type PeppolSubmissionRef = z.infer<typeof peppolSubmissionRefSchema>

export const peppolVerifiedEventSchema = z.object({
  provider: z.string(),
  providerTenantId: z.string().nullable(),
  providerSubmissionId: z.string().nullable(),
  providerEventId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  eventCode: z.string(),
  normalizedStatus: peppolDeliveryStatusSchema,
  isTerminal: z.boolean(),
  detail: z.string().nullable(),
  occurredAt: z.string(),
  rawPayload: z.record(z.string(), z.unknown()),
  eventSha256: z.string(),
  verificationMethod: z.string(),
})
export type PeppolVerifiedEvent = z.infer<typeof peppolVerifiedEventSchema>

export const peppolDeliveryEvidenceSchema = z.object({
  provider: z.string(),
  evidenceType: z.string(),
  payload: z.record(z.string(), z.unknown()),
  exactDocument: z.string().nullable(),
  exactDocumentSha256: z.string().nullable(),
  evidenceSha256: z.string(),
  retrievedAt: z.string(),
})
export type PeppolDeliveryEvidence = z.infer<typeof peppolDeliveryEvidenceSchema>

export const peppolBusinessCardSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  countryCode: z.string().trim().length(2),
  geographicalInformation: z.string().max(500).nullish(),
  vatNumber: z.string().max(64).nullish(),
  orgNumber: z.string().max(64).nullish(),
})

export const peppolRecipientRegistrationRequestSchema = z.object({
  participant: peppolParticipantSchema,
  businessCard: peppolBusinessCardSchema,
  documentTypes: z
    .array(z.object({ processId: z.string().min(1).max(512), documentTypeId: z.string().min(1).max(512) }))
    .min(1)
    .max(20),
  description: z.string().max(200).nullish(),
  /** The installation's own company reference; the service uses the company header. */
  tenantReference: z.string().max(128).nullish(),
})
export type PeppolRecipientRegistrationRequest = z.infer<typeof peppolRecipientRegistrationRequestSchema>

export const peppolRecipientRegistrationResultSchema = z.object({
  status: z.enum(['registered', 'updated']),
  participant: peppolParticipantSchema,
  /** Opaque on the connector: the service never reveals its provider account reference. */
  providerAccountReference: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()),
})
export type PeppolRecipientRegistrationResult = z.infer<typeof peppolRecipientRegistrationResultSchema>

export const peppolInboundListRequestSchema = z.object({
  documentType: peppolDocumentTypeSchema,
  limit: z.number().int().min(1).max(100).optional(),
  includeRead: z.boolean().optional(),
  /**
   * Listing cursor: the newest `receivedAt` the caller has already archived
   * for this document type. A service that supports it lists only documents
   * received after that instant, OLDEST first, so a caller walking the
   * cursor never skips a burst larger than one page; when the field is
   * omitted, listing starts from the oldest archived document. A service
   * that does not support it ignores the field (object schemas strip unknown
   * keys), so the caller must still dedupe by providerDocumentId.
   */
  receivedAfter: z.iso.datetime({ offset: true }).optional(),
})
export type PeppolInboundListRequest = z.infer<typeof peppolInboundListRequestSchema>

export const peppolInboundMessageSchema = z.object({
  provider: z.string(),
  providerDocumentId: z.string(),
  documentType: peppolDocumentTypeSchema,
  payload: z.record(z.string(), z.unknown()),
  receivedAt: z.string().nullable(),
})
export type PeppolInboundMessage = z.infer<typeof peppolInboundMessageSchema>

export const peppolInboundXmlRequestSchema = z.object({
  providerDocumentId: z.string().trim().min(1).max(128),
  documentType: peppolDocumentTypeSchema,
})
export type PeppolInboundXmlRequest = z.infer<typeof peppolInboundXmlRequestSchema>

export const peppolInboundXmlResultSchema = z.object({ xml: z.string().nullable() })
export type PeppolInboundXmlResult = z.infer<typeof peppolInboundXmlResultSchema>

/**
 * The operation table: method, path under `/api/connect/peppol`, whether the
 * company header is required, and the request and response schemas.
 */
export const PEPPOL_OPERATIONS = {
  lookup: { method: 'POST', path: '/lookup', company: false, request: peppolLookupRequestSchema, response: peppolLookupResultSchema },
  submit: { method: 'POST', path: '/submit', company: true, request: peppolSubmissionSchema, response: peppolSubmissionReceiptSchema },
  status: { method: 'POST', path: '/status', company: true, request: peppolSubmissionRefSchema, response: z.array(peppolVerifiedEventSchema) },
  evidence: { method: 'POST', path: '/evidence', company: true, request: peppolSubmissionRefSchema, response: z.array(peppolDeliveryEvidenceSchema) },
  register: { method: 'PUT', path: '/recipient', company: true, request: peppolRecipientRegistrationRequestSchema, response: peppolRecipientRegistrationResultSchema },
  unregister: { method: 'DELETE', path: '/recipient', company: true, request: peppolParticipantSchema, response: z.null() },
  inboundList: { method: 'POST', path: '/inbound/list', company: false, request: peppolInboundListRequestSchema, response: z.array(peppolInboundMessageSchema) },
  inboundXml: { method: 'POST', path: '/inbound/xml', company: false, request: peppolInboundXmlRequestSchema, response: peppolInboundXmlResultSchema },
} as const
export type PeppolOperation = keyof typeof PEPPOL_OPERATIONS
