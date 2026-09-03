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
 * TypeScript types inferred from them. Both sides validate with the same
 * schemas so they cannot drift apart. The package is MIT so that anyone may
 * implement either side of it: a self-hosted ledger talking to Accounted
 * Connect, or an alternative connector service talking to the open ledger.
 *
 * Versioning: `CONTRACT_VERSION` is a date. Fields are only ever added; a
 * breaking change is a new operation or family name, never a changed one.
 */

export const CONTRACT_VERSION = '2026-09-03'

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
  'CONNECTOR_PEPPOL_PARTICIPANT_TAKEN',
  'CONNECTOR_PEPPOL_PARTICIPANT_NOT_ALLOWED',
  'CONNECTOR_PEPPOL_SENDER_NOT_REGISTERED',
  'PEPPOL_RECEIVING_UNSUPPORTED',
  'PEPPOL_REGISTRATION_CAP_REACHED',
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

/** Error codes specific to the bank sync operation. */
export const BANK_SYNC_ERROR_CODES = ['CONNECTOR_BANK_SESSION_EXPIRED', 'CONNECTOR_BANK_UPSTREAM_ERROR'] as const

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
