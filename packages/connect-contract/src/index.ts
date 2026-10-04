import { z } from 'zod'

/**
 * @accounted/connect-contract
 *
 * The wire contract between an Accounted ledger installation (hosted, or a
 * self-hosted instance) and the Accounted Connect service that operates the
 * provider integrations only Accounted can run: bank feeds through its PSD2
 * credentials, the Skatteverket API client, the Peppol access point, company
 * lookup, the migration sources, and the collections and delivery providers
 * a company activates (described at runtime by the catalogue, never named
 * here).
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
 * Every call carries the caller's version in `CONNECTOR_HEADERS.contractVersion`.
 * A response enum only gains a value under a new version, and the service
 * never sends a value the caller's version does not know.
 *
 * This file depends on nothing but `zod`: other repositories consume an exact
 * copy of `src/` pinned to a commit, so it must stay self-contained.
 */

export const CONTRACT_VERSION = '2026-10-04'

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
 *
 * `contractVersion` carries `CONTRACT_VERSION` on every call of every family
 * (bank and Peppol included). The service accepts the current and the
 * previous version, treats a missing header as the previous one, and refuses
 * anything older with CONNECTOR_CONTRACT_VERSION_UNSUPPORTED.
 *
 * `connection` carries the opaque connection handle a provider capability
 * returned at onboarding (collections and delivery). Only the installation
 * keeps it in clear; the service keeps a hash and refuses a handle that is
 * not bound to the calling key and company (CONNECTOR_CONNECTION_NOT_OWNED).
 */
export const CONNECTOR_HEADERS = {
  company: 'X-Connector-Company',
  upstreamAuthorization: 'X-Connector-Upstream-Authorization',
  upstreamContentType: 'X-Connector-Upstream-Content-Type',
  contractVersion: 'X-Connect-Contract-Version',
  connection: 'X-Connector-Connection',
} as const

/** The provider catalogue (GET, key-wide): which capabilities this key may use, and from whom. */
export const CATALOGUE_PATH = '/api/connect/catalogue'
/** Base path of the collections family (reminders, debt collection, settlements). */
export const COLLECTIONS_BASE_PATH = '/api/connect/collections'
/** Base path of the delivery family (sending an invoice by post, digital mailbox or e-invoice). */
export const DELIVERY_BASE_PATH = '/api/connect/delivery'

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
  // The caller's X-Connect-Contract-Version is older than the previous version.
  'CONNECTOR_CONTRACT_VERSION_UNSUPPORTED',
  // Same idempotency key, different request body: nothing was sent.
  'CONNECTOR_IDEMPOTENCY_MISMATCH',
  // Same idempotency key while the first call still runs; retryable.
  'CONNECTOR_IDEMPOTENCY_IN_FLIGHT',
  // The provider is switched off at the service, or the service serves only
  // obligation operations and this is a start operation.
  'CONNECTOR_UPSTREAM_DISABLED',
  // The X-Connector-Connection handle is not bound to this key and company.
  'CONNECTOR_CONNECTION_NOT_OWNED',
  'CONNECTOR_COLLECTIONS_NOT_ONBOARDED',
  'CONNECTOR_COLLECTIONS_NOT_APPROVED',
  'CONNECTOR_COLLECTIONS_CASE_NOT_OWNED',
  // The case's current state does not offer this action.
  'CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE',
  // Missing or invalid debtor address, personal identity number or org number.
  'CONNECTOR_COLLECTIONS_DEBTOR_INVALID',
  // The provider already holds an open case for this invoice.
  'CONNECTOR_COLLECTIONS_DUPLICATE_CASE',
  'CONNECTOR_COLLECTIONS_AMOUNT_INVALID',
  // The debtor cannot be reached through the requested delivery method.
  'CONNECTOR_DELIVERY_METHOD_UNAVAILABLE',
  'CONNECTOR_DELIVERY_DOCUMENT_REJECTED',
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

// ---------------------------------------------------------------------------
// Provider capabilities: shared primitives (catalogue, collections, delivery)
// ---------------------------------------------------------------------------

/**
 * Every write carries one. It is always a row id (or a row id plus a suffix)
 * from the installation's own database, so a retry after a timeout reuses it
 * by construction.
 */
const idempotencyKeySchema = z.string().trim().min(1).max(128)

/** A calendar date, `YYYY-MM-DD`, that exists. */
const isoDateSchema = z.iso.date()

/** A timestamp the installation sends: ISO 8601 with an offset (or Z). */
const isoTimestampSchema = z.iso.datetime({ offset: true })

/** ISO 3166-1 alpha-2, upper case. */
const countryCodeSchema = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, upper case')

/** ISO 4217, upper case. */
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217, upper case')

/**
 * A link the installation renders or opens: https with a domain host only,
 * so a javascript:, data: or bare-IP target can never reach a page.
 */
const httpsUrlSchema = z.url({ protocol: /^https$/, hostname: z.regexes.domain })

/** Ten digits, no dash. */
const orgNumberSchema = z.string().regex(/^\d{10}$/, 'ten digits, no dash')

/**
 * Twelve digits with the century, no dash, normalized and Luhn-checked by the
 * sender. In transit only: the service never stores it, neither side logs it.
 */
const personalNumberSchema = z.string().regex(/^\d{12}$/, 'twelve digits with the century, no dash')

const TWO_DECIMALS = /^-?\d+(\.\d{1,2})?$/

/**
 * An amount the installation sends: rounded to two decimals before sending.
 * The check reads the number's shortest decimal form, so a value carrying
 * float drift (0.1 + 0.2) is refused while every correctly rounded value
 * passes exactly. Amounts the service returns are plain numbers; the
 * installation rounds them itself.
 */
const sentAmountSchema = z
  .number()
  .refine((n) => TWO_DECIMALS.test(String(n)), 'amount must be rounded to two decimals before sending')

type IssueSink = { addIssue: (issue: { code: 'custom'; message: string; path: PropertyKey[] }) => void }

// ---------------------------------------------------------------------------
// Catalogue (installation -> service, GET /api/connect/catalogue)
// ---------------------------------------------------------------------------

/**
 * Which provider capabilities the calling key may use, and the provider
 * behind each. This is where a provider's name, legal identity, terms, data
 * processing terms and fee wording reach an installation: the installation
 * never hard-codes them, and when the catalogue is unreachable it falls back
 * to the name it stored at activation.
 *
 * Entries appear only for capabilities the key's scopes and the service's
 * upstream mode allow. Parse each entry's `features` with
 * CATALOGUE_FEATURE_SCHEMAS (safeParse) and skip an entry whose capability
 * the caller does not know: a newer service may list more.
 */
export const CATALOGUE_CAPABILITIES = ['collections', 'delivery'] as const
export type CatalogueCapability = (typeof CATALOGUE_CAPABILITIES)[number]

export const providerProfileSchema = z.object({
  /** Stable opaque slug; the installation stores it on its connection. */
  ref: z.string().trim().min(1).max(64),
  /** The name the installation shows for the provider. */
  displayName: z.string().trim().min(1).max(80),
  legalName: z.string().trim().min(1).max(200),
  orgNumber: z.string().max(32).nullable(),
  country: countryCodeSchema,
  termsUrl: httpsUrlSchema.nullable(),
  /** The terms version shown BEFORE onboarding; the consent records it. */
  termsVersion: z.string().max(64).nullable(),
  privacyUrl: httpsUrlSchema.nullable(),
  /** The provider's data processing or data sharing terms, if any. */
  dpaUrl: httpsUrlSchema.nullable(),
  dpaVersion: z.string().max(64).nullable(),
  /** The provider's own portal; null hides the link. */
  portalUrl: httpsUrlSchema.nullable(),
  supportUrl: httpsUrlSchema.nullable(),
  /** Term and notice period, in Swedish, shown at activation. */
  termsSummarySv: z.string().max(2000).nullable(),
  /** Who keeps which fees, and the fees on direct payments, in Swedish. */
  feeSummarySv: z.string().max(2000).nullable(),
})
export type ProviderProfile = z.infer<typeof providerProfileSchema>

export const collectionsFeaturesSchema = z.object({
  /** Where a handover may start. */
  startSteps: z.array(z.enum(['reminder', 'collection'])),
  /** Days after handover during which a withdrawal costs nothing; null = unknown, so the installation always warns. */
  withdrawFreeDays: z.number().int().min(0).nullable(),
  currencies: z.array(currencyCodeSchema),
  debtorCountries: z.array(countryCodeSchema),
  /** Whether private persons may be debtors. */
  privateDebtors: z.boolean(),
  minimumAmount: z.number().min(0).nullable(),
  /** Whether the settlement document is a valid VAT invoice for the fees the provider withholds. */
  settlementIsVatInvoice: z.boolean(),
  /** Whether the provider supports the call behind `approve_step`; while false the capability must not be offered. */
  stepApprovalAction: z.boolean(),
})
export type CollectionsFeatures = z.infer<typeof collectionsFeaturesSchema>

/** How an invoice reaches the debtor: by post, in a digital mailbox, or as an e-invoice in the debtor's internet bank. */
export const deliveryMethodSchema = z.enum(['post', 'kivra', 'einvoice_bank'])
export type DeliveryMethod = z.infer<typeof deliveryMethodSchema>

export const deliveryFeaturesSchema = z.object({
  methods: z.array(deliveryMethodSchema),
  /** creditor = the installation's own PDF and payment details; agency = the provider's. */
  payeeModes: z.array(z.enum(['creditor', 'agency'])),
  /**
   * never    = pure delivery: the provider never follows the invoice up (no case).
   * optional = registered without follow-up; the installation may start reminders later with the `start` action.
   * always   = the provider starts its own ladder after the due date.
   */
  followUp: z.enum(['never', 'optional', 'always']),
  maxDocumentChars: z.number().int().positive(),
})
export type DeliveryFeatures = z.infer<typeof deliveryFeaturesSchema>

/** The schema for an entry's `features`, per capability. */
export const CATALOGUE_FEATURE_SCHEMAS = {
  collections: collectionsFeaturesSchema,
  delivery: deliveryFeaturesSchema,
} as const satisfies Record<CatalogueCapability, z.ZodType>

export const catalogueEntrySchema = z.object({
  /** One of CATALOGUE_CAPABILITIES today; a newer service may list more. */
  capability: z.string().trim().min(1).max(64),
  provider: providerProfileSchema,
  /** Parsed per capability by the caller (CATALOGUE_FEATURE_SCHEMAS). */
  features: z.record(z.string(), z.unknown()),
})
export type CatalogueEntry = z.infer<typeof catalogueEntrySchema>

export const catalogueResponseSchema = z.object({
  entries: z.array(catalogueEntrySchema),
  serverTime: z.string(),
})
export type CatalogueResponse = z.infer<typeof catalogueResponseSchema>

/** The operation table, paths under CATALOGUE_PATH. Key-wide, no body. */
export const CATALOGUE_OPERATIONS = {
  list: { method: 'GET', path: '', company: false, request: z.null(), response: catalogueResponseSchema },
} as const
export type CatalogueOperation = keyof typeof CATALOGUE_OPERATIONS

// ---------------------------------------------------------------------------
// Collections (installation -> service, /api/connect/collections/*)
// ---------------------------------------------------------------------------

/**
 * One provider-neutral family for reminders, debt collection and the
 * provider's payouts. Conventions:
 *
 * - Amounts are numbers in the invoice currency (SEK only in this version).
 *   What the installation sends is rounded to two decimals first.
 * - Calendar dates are `YYYY-MM-DD`. Timestamps the installation sends are
 *   ISO 8601 with an offset; timestamps the service returns are ISO strings.
 * - Every write carries `idempotencyKey`, scoped to the calling key, company
 *   and operation: the same value on another operation is another request,
 *   and a revert carries its own key, never the key of the payment report it
 *   undoes. The service answers a retry with the first result and resolves a
 *   timeout by looking up at the provider, never by sending again:
 *   CONNECTOR_IDEMPOTENCY_IN_FLIGHT while the first call still runs,
 *   CONNECTOR_IDEMPOTENCY_MISMATCH for another body under the same key.
 * - Company calls carry X-Connector-Company and, once onboarded,
 *   X-Connector-Connection.
 * - Personal identity numbers, birth dates and debtor contact details travel
 *   in requests only: the service stores none of them and strips them from
 *   every `raw` payload it returns.
 * - Start operations (COLLECTIONS_START_OPERATIONS, and caseAction with one
 *   of COLLECTIONS_START_ACTIONS) begin new work. Everything else serves an
 *   open case or stops work, and keeps running when new work is switched off.
 */

/** In base64 characters (about 2.6 MB of PDF): request bodies to the hosted service are capped at 4.5 MB. */
export const COLLECTIONS_MAX_DOCUMENT_CHARS = 3_500_000

export const postalAddressSchema = z.object({
  line1: z.string().trim().min(1).max(100),
  line2: z.string().max(100).nullable(),
  postalCode: z.string().trim().min(3).max(12),
  city: z.string().trim().min(1).max(60),
  countryCode: countryCodeSchema,
})
export type PostalAddress = z.infer<typeof postalAddressSchema>

export const collectionsDebtorSchema = z.object({
  kind: z.enum(['business', 'private']),
  name: z.string().trim().min(1).max(200),
  /** Required for a business debtor in SE. */
  orgNumber: orgNumberSchema.nullable(),
  /** Required for a private debtor in SE, except on a delivery by post. In transit only, never logged. */
  personalNumber: personalNumberSchema.nullable(),
  vatNumber: z.string().max(20).nullable(),
  customerNumber: z.string().max(50).nullable(),
  /** The installation's own customer id. */
  accountingDebtorRef: z.string().trim().min(1).max(64),
  email: z.email().max(254).nullable(),
  phone: z.string().max(30).nullable(),
  address: postalAddressSchema,
})
export type CollectionsDebtor = z.infer<typeof collectionsDebtorSchema>

/** Identity rules a request with a debtor enforces (kept off the object schema so it stays extendable). */
function checkDebtorIdentity(debtor: CollectionsDebtor, ctx: IssueSink, path: PropertyKey[]): void {
  if (debtor.address?.countryCode !== 'SE') return
  if (debtor.kind === 'business' && debtor.orgNumber === null) {
    ctx.addIssue({ code: 'custom', message: 'a business debtor in SE needs orgNumber', path: [...path, 'orgNumber'] })
  }
  if (debtor.kind === 'private' && debtor.personalNumber === null) {
    ctx.addIssue({ code: 'custom', message: 'a private debtor in SE needs personalNumber', path: [...path, 'personalNumber'] })
  }
}

export const collectionsDocumentInputSchema = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.literal('application/pdf'),
  base64: z.base64().min(1).max(COLLECTIONS_MAX_DOCUMENT_CHARS),
  /** Lower-case hex sha256 of the decoded PDF bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type CollectionsDocumentInput = z.infer<typeof collectionsDocumentInputSchema>

/** The connection's four states; `subStatus` carries the provider detail. */
export const collectionsConnectionStateSchema = z.enum(['connecting', 'needs_setup', 'active', 'disconnected'])
export type CollectionsConnectionState = z.infer<typeof collectionsConnectionStateSchema>

export const collectionsConnectionSubStatusSchema = z.enum([
  'not_started',
  'awaiting_terms',
  'awaiting_signature',
  'awaiting_kyc',
  'in_review',
  'rejected',
  'disabled',
])
export type CollectionsConnectionSubStatus = z.infer<typeof collectionsConnectionSubStatusSchema>

/**
 * Settings the installation writes. Both approvals are locked on in this
 * version: the provider asks before legal action, and before every collection
 * notice, so each one passes the installation's own "may already be paid"
 * check first.
 */
export const collectionsSettingsSchema = z.object({
  approveBeforeLegalAction: z.literal(true),
  approveBeforeCollectionNotice: z.literal(true),
  minimumAmount: sentAmountSchema.min(0),
  deliveryEnabled: z.boolean(),
})
export type CollectionsSettings = z.infer<typeof collectionsSettingsSchema>

/**
 * Settings as the provider holds them now. Plain booleans, so a setting that
 * was changed at the provider shows up as such instead of failing the parse.
 */
export const collectionsSettingsStateSchema = z.object({
  approveBeforeLegalAction: z.boolean(),
  approveBeforeCollectionNotice: z.boolean(),
  minimumAmount: z.number().min(0),
  deliveryEnabled: z.boolean(),
})
export type CollectionsSettingsState = z.infer<typeof collectionsSettingsStateSchema>

export const collectionsConnectionSchema = z.object({
  state: collectionsConnectionStateSchema,
  subStatus: collectionsConnectionSubStatusSchema.nullable(),
  /** The provider's raw state, for support. */
  providerStatus: z.string().nullable(),
  /** Opaque and secret-free. The installation stores it and sends it as X-Connector-Connection; the service keeps a hash. */
  connectionHandle: z.string().min(1).max(256).nullable(),
  terms: z.object({ version: z.string(), url: httpsUrlSchema.nullable(), accepted: z.boolean() }).nullable(),
  /** Who still has to sign, in transit only: the service never stores it. */
  signers: z.array(z.string()),
  settings: collectionsSettingsStateSchema.nullable(),
  updatedAt: z.string(),
})
export type CollectionsConnection = z.infer<typeof collectionsConnectionSchema>

export const collectionsConnectionRequestSchema = z.object({})
export type CollectionsConnectionRequest = z.infer<typeof collectionsConnectionRequestSchema>

export const collectionsCreditorSchema = z.object({
  kind: z.enum(['company', 'sole_trader']),
  name: z.string().trim().min(1).max(100),
  orgNumber: orgNumberSchema,
  /** The owner's number: required for a sole trader, null for a company. In transit only. */
  personalNumber: personalNumberSchema.nullable(),
  vatRegistered: z.boolean(),
  vatNumber: z.string().max(20).nullable(),
  email: z.email().max(254),
  phone: z.string().max(30).nullable(),
  address: postalAddressSchema,
  payout: z.object({
    kind: z.enum(['bankgiro', 'plusgiro', 'bank_account']),
    number: z.string().trim().min(5).max(34),
  }),
})
export type CollectionsCreditor = z.infer<typeof collectionsCreditorSchema>

/** Know-your-customer answers. Each description is required when its flag is true. */
export const collectionsKycSchema = z.object({
  businessDescription: z.string().trim().min(2).max(500),
  invoicesAbroad: z.boolean(),
  invoicesAbroadDescription: z.string().max(500).nullable(),
  pep: z.boolean(),
  pepDescription: z.string().max(500).nullable(),
  sanctions: z.boolean(),
  sanctionsDescription: z.string().max(500).nullable(),
})
export type CollectionsKyc = z.infer<typeof collectionsKycSchema>

export const collectionsOnboardingRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    /** Given in the installation BEFORE any company data leaves it. */
    consent: z.object({
      termsVersion: z.string().trim().min(1).max(64),
      dpaVersion: z.string().max(64).nullable(),
      consentedByName: z.string().trim().min(1).max(200),
      consentedAt: isoTimestampSchema,
    }),
    creditor: collectionsCreditorSchema,
    kyc: collectionsKycSchema,
    settings: collectionsSettingsSchema,
  })
  .superRefine((req, ctx) => {
    if (req.creditor.kind === 'sole_trader' && req.creditor.personalNumber === null) {
      ctx.addIssue({ code: 'custom', message: 'a sole trader needs the owner personalNumber', path: ['creditor', 'personalNumber'] })
    }
    if (req.creditor.kind === 'company' && req.creditor.personalNumber !== null) {
      ctx.addIssue({ code: 'custom', message: 'a company sends no personalNumber', path: ['creditor', 'personalNumber'] })
    }
    const answers = [
      ['invoicesAbroad', 'invoicesAbroadDescription'],
      ['pep', 'pepDescription'],
      ['sanctions', 'sanctionsDescription'],
    ] as const
    for (const [flag, description] of answers) {
      if (req.kyc[flag] && !req.kyc[description]?.trim()) {
        ctx.addIssue({ code: 'custom', message: `${description} is required when ${flag} is true`, path: ['kyc', description] })
      }
    }
  })
export type CollectionsOnboardingRequest = z.infer<typeof collectionsOnboardingRequestSchema>

export const collectionsCancelOnboardingRequestSchema = z.object({ idempotencyKey: idempotencyKeySchema })
export type CollectionsCancelOnboardingRequest = z.infer<typeof collectionsCancelOnboardingRequestSchema>

export const collectionsTermsAcceptRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  termsVersion: z.string().trim().min(1).max(64),
  acceptedByName: z.string().trim().min(1).max(200),
  acceptedAt: isoTimestampSchema,
})
export type CollectionsTermsAcceptRequest = z.infer<typeof collectionsTermsAcceptRequestSchema>

export const collectionsSignatureStartRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  signerEmail: z.email().max(254),
  /** true = the provider e-mails the signing link to the signer (signUrl comes back null). */
  sendToSigner: z.boolean(),
  /** Where the provider sends the signer afterwards: a page of the installation. */
  redirectUrl: z.url({ protocol: /^https?$/ }),
  language: z.enum(['sv', 'en']),
})
export type CollectionsSignatureStartRequest = z.infer<typeof collectionsSignatureStartRequestSchema>

export const collectionsSignatureStartSchema = z.object({
  signUrl: httpsUrlSchema.nullable(),
  signers: z.array(z.string()),
})
export type CollectionsSignatureStart = z.infer<typeof collectionsSignatureStartSchema>

export const collectionsSettingsUpdateRequestSchema = collectionsSettingsSchema.extend({ idempotencyKey: idempotencyKeySchema })
export type CollectionsSettingsUpdateRequest = z.infer<typeof collectionsSettingsUpdateRequestSchema>

export const collectionsDisconnectRequestSchema = z.object({ idempotencyKey: idempotencyKeySchema })
export type CollectionsDisconnectRequest = z.infer<typeof collectionsDisconnectRequestSchema>

/** Where a case is, in provider-neutral terms. `unknown` keeps a provider state no mapping knows yet. */
export const collectionsStageSchema = z.enum([
  'registered',
  'invoice_sent',
  'reminder',
  'collection',
  'awaiting_decision',
  'enforcement',
  'payment_plan',
  'monitoring',
  'paused',
  'closed_paid',
  'closed_other',
  'unknown',
])
export type CollectionsStage = z.infer<typeof collectionsStageSchema>

/** What the provider waits for while the stage is `awaiting_decision`. */
export const collectionsDecisionKindSchema = z.enum([
  'approve_reminder',
  'approve_collection_notice',
  'legal_action',
  'legal_action_not_recommended',
  'dispute',
  'debtor_says_paid',
  'other',
])
export type CollectionsDecisionKind = z.infer<typeof collectionsDecisionKindSchema>

export const collectionsCloseReasonSchema = z.enum([
  'paid',
  'withdrawn',
  'credited',
  'insolvent',
  'bankrupt',
  'deceased',
  'moved_abroad',
  'error',
  'other',
])
export type CollectionsCloseReason = z.infer<typeof collectionsCloseReasonSchema>

export const collectionsActionSchema = z.enum([
  /** Start reminders on a delivered invoice; `step` says where. */
  'start',
  'pause',
  'resume',
  'withdraw',
  'dispute',
  'contest_dispute',
  /** Approve a waiting reminder or collection notice (decision kinds approve_*). */
  'approve_step',
  /** The creditor confirms the debtor's "already paid". */
  'already_paid',
  /** The creditor answers the debtor's "already paid" with "not paid". */
  'confirm_not_paid',
  'approve_legal_action',
  'decline_legal_action',
])
export type CollectionsAction = z.infer<typeof collectionsActionSchema>

/** caseAction values that begin new work (the rest serve an open case). */
export const COLLECTIONS_START_ACTIONS = ['start', 'approve_step'] as const satisfies readonly CollectionsAction[]

/** The invoice behind a case or a delivery. */
export const collectionsInvoiceSchema = z.object({
  /** The installation's own invoice id. */
  ref: z.string().trim().min(1).max(64),
  number: z.string().trim().min(1).max(50),
  issueDate: isoDateSchema,
  dueDate: isoDateSchema,
  currency: z.literal('SEK'),
  /** What the customer was asked to pay: the printed amount due (the customer's share after ROT/RUT, after rounding). */
  claimAmount: sentAmountSchema.positive(),
  /** The VAT inside claimAmount, pro rata. */
  claimVatAmount: sentAmountSchema.min(0),
  /** The customer's share still unpaid. */
  claimRemaining: sentAmountSchema.positive(),
  /** The customer's reference ("Er referens"). */
  reference: z.string().max(100).nullable(),
})
export type CollectionsInvoice = z.infer<typeof collectionsInvoiceSchema>

function checkInvoice(invoice: CollectionsInvoice, ctx: IssueSink, path: PropertyKey[]): void {
  if (invoice.dueDate < invoice.issueDate) {
    ctx.addIssue({ code: 'custom', message: 'dueDate is before issueDate', path: [...path, 'dueDate'] })
  }
  if (invoice.claimVatAmount > invoice.claimAmount) {
    ctx.addIssue({ code: 'custom', message: 'claimVatAmount exceeds claimAmount', path: [...path, 'claimVatAmount'] })
  }
  if (invoice.claimRemaining > invoice.claimAmount) {
    ctx.addIssue({ code: 'custom', message: 'claimRemaining exceeds claimAmount', path: [...path, 'claimRemaining'] })
  }
}

/**
 * A contractual late interest rate. Sent only when the debtor agreed to it
 * before the invoice was issued; null leaves the statutory rate to the
 * provider. Never for a private debtor in this version.
 */
export const collectionsLateInterestSchema = z.object({
  annualPercent: z.number().min(0).max(100),
  /** Interest runs from this date, never before the due date. */
  fromDate: isoDateSchema,
  /** When the debtor agreed to the rate; only invoices issued on or after it may carry it. */
  agreedSince: isoDateSchema,
})
export type CollectionsLateInterest = z.infer<typeof collectionsLateInterestSchema>

export const collectionsPriorPaymentSchema = z.object({
  /** The installation's own payment row id. */
  paymentRef: z.string().trim().min(1).max(64),
  date: isoDateSchema,
  amount: sentAmountSchema.positive(),
})
export type CollectionsPriorPayment = z.infer<typeof collectionsPriorPaymentSchema>

export const collectionsPriorCreditSchema = z.object({
  /** The installation's own credit note id. */
  creditRef: z.string().trim().min(1).max(64),
  date: isoDateSchema,
  amount: sentAmountSchema.positive(),
})
export type CollectionsPriorCredit = z.infer<typeof collectionsPriorCreditSchema>

export const collectionsOpenCaseRequestSchema = z
  .object({
    /** The installation's case row id; also the case reference at the provider. */
    idempotencyKey: idempotencyKeySchema,
    invoice: collectionsInvoiceSchema,
    /** Where the handover starts. A delivered invoice is started with the `start` action instead. */
    startStep: z.enum(['reminder', 'collection']),
    /** Grace before the first letter, if any. */
    nextActionDate: isoDateSchema.nullable(),
    /** Whether a reminder fee was agreed for this invoice. */
    reminderFeeAgreed: z.boolean(),
    lateInterest: collectionsLateInterestSchema.nullable(),
    /** Payments the installation already recorded on the invoice. */
    priorPayments: z.array(collectionsPriorPaymentSchema),
    /** Credit notes already issued against the invoice. */
    priorCredits: z.array(collectionsPriorCreditSchema),
    debtor: collectionsDebtorSchema,
    document: collectionsDocumentInputSchema,
  })
  .superRefine((req, ctx) => {
    checkInvoice(req.invoice, ctx, ['invoice'])
    checkDebtorIdentity(req.debtor, ctx, ['debtor'])
    const interest = req.lateInterest
    if (!interest) return
    if (req.debtor.kind === 'private') {
      ctx.addIssue({ code: 'custom', message: 'no contractual late interest for a private debtor', path: ['lateInterest'] })
    }
    if (interest.agreedSince > req.invoice.issueDate) {
      ctx.addIssue({ code: 'custom', message: 'the rate was agreed after the invoice was issued', path: ['lateInterest', 'agreedSince'] })
    }
    if (interest.fromDate < req.invoice.dueDate) {
      ctx.addIssue({ code: 'custom', message: 'late interest cannot run before the due date', path: ['lateInterest', 'fromDate'] })
    }
  })
export type CollectionsOpenCaseRequest = z.infer<typeof collectionsOpenCaseRequestSchema>

export const collectionsEventSchema = z.object({
  eventRef: z.string().max(128),
  occurredAt: z.string(),
  kind: z.enum(['stage', 'letter', 'sms', 'call', 'payment', 'note', 'decision', 'other']),
  direction: z.enum(['to_debtor', 'from_debtor', 'internal']).nullable(),
  /** The provider's own Swedish label. */
  label: z.string().max(300),
  amount: z.number().nullable(),
})
export type CollectionsEvent = z.infer<typeof collectionsEventSchema>

/** A payment the debtor made to the PROVIDER. */
export const collectionsCollectedPaymentSchema = z.object({
  paymentRef: z.string().max(128),
  paidAt: isoDateSchema,
  total: z.number(),
  /** The gross reduction of the open capital, credited to the creditor in full. */
  capitalPaid: z.number(),
  /** Interest or fees passed on to the creditor. */
  toCreditorOther: z.number(),
  /** Fees and interest the provider keeps. */
  toAgency: z.number(),
})
export type CollectionsCollectedPayment = z.infer<typeof collectionsCollectedPaymentSchema>

/** A payment the INSTALLATION reported, as the provider sees it (acknowledges a forward). */
export const collectionsReportedPaymentSchema = z.object({
  paymentRef: z.string().max(64),
  amount: z.number(),
  matchedAmount: z.number(),
  date: isoDateSchema,
})
export type CollectionsReportedPayment = z.infer<typeof collectionsReportedPaymentSchema>

export const collectionsCaseDocumentRefSchema = z.object({
  documentRef: z.string(),
  type: z.enum(['closing_letter', 'enforcement_decision', 'letter_to_debtor', 'other']),
  createdAt: z.string(),
  filename: z.string(),
})
export type CollectionsCaseDocumentRef = z.infer<typeof collectionsCaseDocumentRefSchema>

export const collectionsCaseSchema = z.object({
  caseRef: z.string().max(128),
  caseNumber: z.string().max(64).nullable(),
  /** The installation's own invoice id. */
  invoiceRef: z.string().max(64),
  stage: collectionsStageSchema,
  /** False only for the closed stages. */
  isOpen: z.boolean(),
  closeReason: collectionsCloseReasonSchema.nullable(),
  /** Non-null only while the stage is `awaiting_decision`. */
  decisionKind: collectionsDecisionKindSchema.nullable(),
  providerState: z.string(),
  providerStateLabel: z.string(),
  outstandingPrincipal: z.number(),
  outstandingTotal: z.number(),
  currency: currencyCodeSchema,
  nextActionDate: isoDateSchema.nullable(),
  nextActionLabel: z.string().nullable(),
  /** The actions the case offers right now. */
  actions: z.array(collectionsActionSchema),
  /** Set when the provider merged this case into another. */
  parentCaseRef: z.string().nullable(),
  events: z.array(collectionsEventSchema),
  collectedPayments: z.array(collectionsCollectedPaymentSchema),
  reportedPayments: z.array(collectionsReportedPaymentSchema),
  documents: z.array(collectionsCaseDocumentRefSchema),
  updatedAt: z.string(),
  /** The provider payload through an allowlist: no personal identity number, birth date, address or contact details. */
  raw: z.record(z.string(), z.unknown()),
})
export type CollectionsCase = z.infer<typeof collectionsCaseSchema>

export const collectionsOpenCaseReceiptSchema = z.object({ acceptedAt: z.string(), case: collectionsCaseSchema })
export type CollectionsOpenCaseReceipt = z.infer<typeof collectionsOpenCaseReceiptSchema>

const caseRefSchema = z.string().trim().min(1).max(128)

export const collectionsCaseRefSchema = z.object({ caseRef: caseRefSchema })
export type CollectionsCaseRef = z.infer<typeof collectionsCaseRefSchema>

export const collectionsCaseActionRequestSchema = z
  .object({
    idempotencyKey: idempotencyKeySchema,
    caseRef: caseRefSchema,
    action: collectionsActionSchema,
    /** Required for `start`, null for every other action. */
    step: z.enum(['reminder', 'collection']).nullable(),
    message: z.string().max(2000).nullable(),
    until: isoDateSchema.nullable(),
  })
  .superRefine((req, ctx) => {
    if (req.action === 'start' && req.step === null) {
      ctx.addIssue({ code: 'custom', message: 'start needs a step', path: ['step'] })
    }
    if (req.action !== 'start' && req.step !== null) {
      ctx.addIssue({ code: 'custom', message: 'only start takes a step', path: ['step'] })
    }
  })
export type CollectionsCaseActionRequest = z.infer<typeof collectionsCaseActionRequestSchema>

/** A payment the debtor made directly to the creditor, reported to the provider. */
export const collectionsDirectPaymentRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  caseRef: caseRefSchema,
  /** The installation's own payment row id: the same id later reverts it. */
  paymentRef: z.string().trim().min(1).max(64),
  date: isoDateSchema,
  amount: sentAmountSchema.positive(),
  description: z.string().max(200).nullable(),
})
export type CollectionsDirectPaymentRequest = z.infer<typeof collectionsDirectPaymentRequestSchema>

/** Undo a reported payment (the installation removed or unmatched it). Same shape and paymentRef as the report, under its own idempotencyKey. */
export const collectionsRevertPaymentRequestSchema = collectionsDirectPaymentRequestSchema
export type CollectionsRevertPaymentRequest = z.infer<typeof collectionsRevertPaymentRequestSchema>

export const collectionsCreditNoteRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  caseRef: caseRefSchema,
  /** The installation's own credit note id. */
  creditRef: z.string().trim().min(1).max(64),
  date: isoDateSchema,
  amount: sentAmountSchema.positive(),
})
export type CollectionsCreditNoteRequest = z.infer<typeof collectionsCreditNoteRequestSchema>

export const collectionsPaymentReceiptSchema = z.object({
  accepted: z.boolean(),
  providerRef: z.string().nullable(),
  /** The part the provider ignored (for example a payment above the remaining capital). */
  ignoredAmount: z.number(),
})
export type CollectionsPaymentReceipt = z.infer<typeof collectionsPaymentReceiptSchema>

/** A change-log position: a decimal sequence number, so the caller can re-read with an overlap. */
const changeSeqSchema = z.string().regex(/^\d{1,20}$/, 'decimal sequence number')

export const collectionsChangesRequestSchema = z.object({
  /** Serve changes after this sequence number; null = from the oldest kept. */
  after: changeSeqSchema.nullable(),
  limit: z.number().int().min(1).max(500).optional(),
})
export type CollectionsChangesRequest = z.infer<typeof collectionsChangesRequestSchema>

/**
 * The change log, key-wide: each change names its company. The service
 * serves only changes older than a short commit-lag window, so the caller
 * re-reads with an overlap and dedupes; processing a change twice is
 * harmless because the caller re-reads the case itself.
 */
export const collectionsChangesSchema = z.object({
  changes: z.array(
    z.object({
      seq: changeSeqSchema,
      /** The X-Connector-Company value the change belongs to. */
      companyRef: z.string(),
      kind: z.enum(['case', 'delivery', 'settlement']),
      /**
       * case and delivery: the installation's own id (the case or delivery
       * idempotency key). settlement: the provider's opaque settlement handle,
       * which the installation cannot know in advance.
       */
      ref: z.string(),
      changedAt: z.string(),
    }),
  ),
  /** Pass as `after` for the next page; null when there is no more. */
  next: changeSeqSchema.nullable(),
})
export type CollectionsChanges = z.infer<typeof collectionsChangesSchema>

/** One line of a payout. Each kind maps to accounts on the installation; `unknown` always needs a person. */
export const collectionsSettlementLineSchema = z.object({
  kind: z.enum([
    'principal',
    'interest_to_creditor',
    'fee_to_creditor',
    'cost_refund_to_creditor',
    'agency_commission',
    'agency_fee_vat',
    'fee_charged_to_creditor',
    'court_fee',
    'supplier_invoice_setoff',
    'excess_direct_payment',
    'informational',
    'unknown',
  ]),
  /** false = shown for information, not part of the amount paid out. */
  inPayout: z.boolean(),
  amount: z.number(),
  taxAmount: z.number(),
  recipient: z.enum(['creditor', 'agency', 'tax_authority', 'enforcement_authority', 'partner']),
  caseRef: z.string().nullable(),
  /** The installation's own invoice id, when the line belongs to one. */
  invoiceRef: z.string().nullable(),
  /** For merged cases: the original invoices the line covers. */
  originalInvoiceRefs: z.array(z.string()),
  providerType: z.string(),
  description: z.string().nullable(),
})
export type CollectionsSettlementLine = z.infer<typeof collectionsSettlementLineSchema>

export const collectionsSettlementSummarySchema = z.object({
  settlementRef: z.string(),
  paymentDate: isoDateSchema,
  amount: z.number(),
  currency: currencyCodeSchema,
  /** false = the provider marks the settlement as not valid; it is never booked automatically. */
  statusOk: z.boolean(),
})
export type CollectionsSettlementSummary = z.infer<typeof collectionsSettlementSummarySchema>

export const collectionsSettlementSchema = collectionsSettlementSummarySchema.extend({
  settlementDate: isoDateSchema.nullable(),
  statusCode: z.string(),
  bankReference: z.string().nullable(),
  lines: z.array(collectionsSettlementLineSchema),
  /** Allowlisted provider payload; the embedded debtor object is stripped. */
  raw: z.record(z.string(), z.unknown()),
})
export type CollectionsSettlement = z.infer<typeof collectionsSettlementSchema>

export const collectionsSettlementsRequestSchema = z.object({ since: isoDateSchema })
export type CollectionsSettlementsRequest = z.infer<typeof collectionsSettlementsRequestSchema>

export const collectionsSettlementRefSchema = z.object({ settlementRef: z.string().trim().min(1).max(128) })
export type CollectionsSettlementRef = z.infer<typeof collectionsSettlementRefSchema>

/** A document the service returns (case letter, settlement specification). */
export const collectionsDocumentSchema = z.object({
  filename: z.string(),
  contentType: z.string(),
  base64: z.string(),
  /** Lower-case hex sha256 of the decoded bytes. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
})
export type CollectionsDocument = z.infer<typeof collectionsDocumentSchema>

export const collectionsSettlementBookedRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  settlementRef: z.string().trim().min(1).max(128),
  /** The installation's own voucher id for the booking. */
  internalRef: z.string().trim().min(1).max(64),
})
export type CollectionsSettlementBookedRequest = z.infer<typeof collectionsSettlementBookedRequestSchema>

export const collectionsCaseDocumentRequestSchema = z.object({
  caseRef: caseRefSchema,
  documentRef: z.string().trim().min(1).max(128),
})
export type CollectionsCaseDocumentRequest = z.infer<typeof collectionsCaseDocumentRequestSchema>

/**
 * The operation table: method, path under COLLECTIONS_BASE_PATH, whether the
 * company header is required, and the request and response schemas.
 */
export const COLLECTIONS_OPERATIONS = {
  connection: { method: 'POST', path: '/connection', company: true, request: collectionsConnectionRequestSchema, response: collectionsConnectionSchema },
  onboard: { method: 'POST', path: '/onboarding', company: true, request: collectionsOnboardingRequestSchema, response: collectionsConnectionSchema },
  cancelOnboarding: { method: 'POST', path: '/onboarding/cancel', company: true, request: collectionsCancelOnboardingRequestSchema, response: collectionsConnectionSchema },
  acceptTerms: { method: 'POST', path: '/onboarding/terms', company: true, request: collectionsTermsAcceptRequestSchema, response: collectionsConnectionSchema },
  startSignature: { method: 'POST', path: '/onboarding/signature', company: true, request: collectionsSignatureStartRequestSchema, response: collectionsSignatureStartSchema },
  updateSettings: { method: 'PUT', path: '/settings', company: true, request: collectionsSettingsUpdateRequestSchema, response: collectionsConnectionSchema },
  disconnect: { method: 'DELETE', path: '/connection', company: true, request: collectionsDisconnectRequestSchema, response: collectionsConnectionSchema },
  openCase: { method: 'POST', path: '/cases', company: true, request: collectionsOpenCaseRequestSchema, response: collectionsOpenCaseReceiptSchema },
  getCase: { method: 'POST', path: '/cases/get', company: true, request: collectionsCaseRefSchema, response: collectionsCaseSchema },
  caseAction: { method: 'POST', path: '/cases/action', company: true, request: collectionsCaseActionRequestSchema, response: collectionsCaseSchema },
  caseDocument: { method: 'POST', path: '/cases/document', company: true, request: collectionsCaseDocumentRequestSchema, response: collectionsDocumentSchema },
  registerPayment: { method: 'POST', path: '/payments', company: true, request: collectionsDirectPaymentRequestSchema, response: collectionsPaymentReceiptSchema },
  revertPayment: { method: 'POST', path: '/payments/revert', company: true, request: collectionsRevertPaymentRequestSchema, response: collectionsPaymentReceiptSchema },
  registerCreditNote: { method: 'POST', path: '/credit-notes', company: true, request: collectionsCreditNoteRequestSchema, response: collectionsPaymentReceiptSchema },
  changes: { method: 'POST', path: '/changes', company: false, request: collectionsChangesRequestSchema, response: collectionsChangesSchema },
  settlements: { method: 'POST', path: '/settlements/list', company: true, request: collectionsSettlementsRequestSchema, response: z.array(collectionsSettlementSummarySchema) },
  settlement: { method: 'POST', path: '/settlements/get', company: true, request: collectionsSettlementRefSchema, response: collectionsSettlementSchema },
  settlementDocument: { method: 'POST', path: '/settlements/document', company: true, request: collectionsSettlementRefSchema, response: collectionsDocumentSchema },
  settlementBooked: { method: 'POST', path: '/settlements/booked', company: true, request: collectionsSettlementBookedRequestSchema, response: z.null() },
} as const
export type CollectionsOperation = keyof typeof COLLECTIONS_OPERATIONS

/**
 * Operations that begin new work. With caseAction, the action decides
 * (COLLECTIONS_START_ACTIONS). Every other operation, cancelOnboarding
 * included, serves an open case or stops work and is always served.
 */
export const COLLECTIONS_START_OPERATIONS = ['onboard', 'acceptTerms', 'startSignature', 'openCase'] as const satisfies readonly CollectionsOperation[]

// ---------------------------------------------------------------------------
// Delivery (installation -> service, /api/connect/delivery/*)
// ---------------------------------------------------------------------------

/**
 * Sending an invoice the installation issued, as its own PDF, by post, to a
 * digital mailbox or as an e-invoice in the debtor's internet bank. Same
 * conventions as the collections family (amounts, dates, idempotency,
 * headers, personal data in transit only). The payee is always the creditor
 * in this version: the installation's PDF, bankgiro and OCR.
 */

export const deliveryMethodsRequestSchema = z
  .object({
    /** Post needs no lookup. */
    method: z.enum(['kivra', 'einvoice_bank']),
    /** Identifiers only: a lookup never carries a name or an address. */
    debtor: z.object({
      kind: z.enum(['business', 'private']),
      orgNumber: orgNumberSchema.nullable(),
      personalNumber: personalNumberSchema.nullable(),
    }),
  })
  .superRefine((req, ctx) => {
    if (req.debtor.kind === 'business' && req.debtor.orgNumber === null) {
      ctx.addIssue({ code: 'custom', message: 'a business lookup needs orgNumber', path: ['debtor', 'orgNumber'] })
    }
    if (req.debtor.kind === 'private' && req.debtor.personalNumber === null) {
      ctx.addIssue({ code: 'custom', message: 'a private lookup needs personalNumber', path: ['debtor', 'personalNumber'] })
    }
  })
export type DeliveryMethodsRequest = z.infer<typeof deliveryMethodsRequestSchema>

export const deliveryMethodsSchema = z.object({
  method: deliveryMethodSchema,
  reachable: z.boolean(),
  reasonCode: z.string().nullable(),
  checkedAt: z.string(),
})
export type DeliveryMethods = z.infer<typeof deliveryMethodsSchema>

/** Register the delivered invoice for later follow-up; only when the catalogue says followUp = 'optional'. */
export const deliveryFollowUpSchema = z.object({
  /** The installation's case row id of the case that watches the invoice. */
  caseIdempotencyKey: idempotencyKeySchema,
  reminderFeeAgreed: z.boolean(),
})
export type DeliveryFollowUp = z.infer<typeof deliveryFollowUpSchema>

export const deliverySendRequestSchema = z
  .object({
    /** The installation's delivery row id. */
    idempotencyKey: idempotencyKeySchema,
    method: deliveryMethodSchema,
    invoice: collectionsInvoiceSchema,
    debtor: collectionsDebtorSchema,
    document: collectionsDocumentInputSchema,
    followUp: deliveryFollowUpSchema.nullable(),
  })
  .superRefine((req, ctx) => {
    checkInvoice(req.invoice, ctx, ['invoice'])
    if (req.method === 'post') {
      // Post needs a name and a full address. A Swedish business still sends
      // its org number, but a private person's identity number is not needed
      // for a letter, so it is never required here (data minimisation).
      if (req.debtor.address?.countryCode === 'SE' && req.debtor.kind === 'business' && req.debtor.orgNumber === null) {
        ctx.addIssue({ code: 'custom', message: 'a business debtor in SE needs orgNumber', path: ['debtor', 'orgNumber'] })
      }
      return
    }
    if (req.debtor.kind === 'business' && req.debtor.orgNumber === null) {
      ctx.addIssue({ code: 'custom', message: `${req.method} needs the debtor's orgNumber`, path: ['debtor', 'orgNumber'] })
    }
    if (req.debtor.kind === 'private' && req.debtor.personalNumber === null) {
      ctx.addIssue({ code: 'custom', message: `${req.method} needs the debtor's personalNumber`, path: ['debtor', 'personalNumber'] })
    }
  })
export type DeliverySendRequest = z.infer<typeof deliverySendRequestSchema>

export const deliveryReceiptSchema = z.object({
  /** The provider's opaque delivery handle; status reads use it. */
  deliveryRef: z.string().min(1),
  acceptedAt: z.string(),
  scheduledFor: z.string().nullable(),
  /** Non-null when followUp was sent (stage invoice_sent). */
  case: collectionsCaseSchema.nullable(),
})
export type DeliveryReceipt = z.infer<typeof deliveryReceiptSchema>

export const deliveryStatusRequestSchema = z.object({ deliveryRef: z.string().trim().min(1).max(128) })
export type DeliveryStatusRequest = z.infer<typeof deliveryStatusRequestSchema>

export const deliveryStatusSchema = z.object({
  state: z.enum(['scheduled', 'sent', 'delivered', 'failed', 'returned']),
  method: deliveryMethodSchema,
  occurredAt: z.string(),
  detail: z.string().nullable(),
})
export type DeliveryStatus = z.infer<typeof deliveryStatusSchema>

/** The operation table, paths under DELIVERY_BASE_PATH. */
export const DELIVERY_OPERATIONS = {
  methods: { method: 'POST', path: '/methods', company: true, request: deliveryMethodsRequestSchema, response: deliveryMethodsSchema },
  send: { method: 'POST', path: '/send', company: true, request: deliverySendRequestSchema, response: deliveryReceiptSchema },
  status: { method: 'POST', path: '/status', company: true, request: deliveryStatusRequestSchema, response: z.array(deliveryStatusSchema) },
} as const
export type DeliveryOperation = keyof typeof DELIVERY_OPERATIONS

/** Delivery operations that begin new work; `status` serves a delivery already made. */
export const DELIVERY_START_OPERATIONS = ['methods', 'send'] as const satisfies readonly DeliveryOperation[]
