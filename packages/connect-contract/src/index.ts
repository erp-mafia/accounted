import { z } from 'zod'

/**
 * @accounted/connect-contract
 *
 * The wire contract between an Accounted ledger installation (hosted, or a
 * self-hosted instance) and the Accounted Connect service that operates the
 * provider integrations only Accounted can run: bank feeds through its PSD2
 * credentials, the Skatteverket API client, the Peppol access point, company
 * lookup, the migration sources, bank payments through the payment
 * initiation provider, bank reading (consents, accounts, balances, booked
 * transactions) through the account information provider, and the
 * collections and delivery providers a company activates (described at
 * runtime by the catalogue, never named here).
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
 * 2026-10-15 added the AIS enrichment to the bank sync shape: the Bankgirot
 * split as `parts`, the counterparty's organisationsnummer, the card merchant
 * category code, the currency exchange, the balance after the row (never for
 * a personal account), the bank's enriched flag, and per sync the account's
 * `enrichment` moment. All optional: a ledger on the previous version still
 * parses the response.
 *
 * This file depends on nothing but `zod`: other repositories consume an exact
 * copy of `src/` pinned to a commit, so it must stay self-contained.
 *
 * 2026-10-16 added two reads to the payments family, Bankgiro Lookup:
 * `lookupCreditor` (the name Bankgirot has registered for a bankgiro or
 * plusgiro number, and whether an OCR reference passes the creditor's
 * check) and `lookupGiroNumbers` (the giro numbers registered to a company).
 * New operations only: nothing existing changed shape.
 *
 * 2026-10-17 added `psuAuthoriserId` to the AIS and the payments party: the
 * signer's logon id at a bank that asks for one besides BankID (Nordea
 * Corporate Netbank), sent to the provider as PSU-Authoriser-ID on the
 * authorisation calls only. Optional: a party without it is the party of
 * the previous version.
 *
 * Two optional request fields of AIS consent creation came later without a
 * new version (2026-11-08): `replacesConsentId` and `replacedPersonalNumber`.
 * A request field needs none: an older service strips it and answers as
 * before (the old consent still counts toward the company's quota), and no
 * response changed. A version moved for them would only make every call of a
 * newer installation look ahead of a service not yet re-pinned.
 *
 * The spend family (company card and spend platforms: approved, coded
 * expenses with their receipts, delivered for booking) came later still,
 * also without a new version, for the same reason: a new family only,
 * nothing existing changed shape.
 */

export const CONTRACT_VERSION = '2026-10-17'

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
  /** The provider's own code when a provider refused or failed (payments: OCR_REF_INVALID, CREDITOR_ACCOUNT_FLAGGED, ...). */
  providerCode: z.string().nullable().optional(),
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
  // The payments provider is not configured or not usable at the service (certificate, credentials): an operator must act.
  'CONNECTOR_PAYMENTS_PROVIDER_UNAVAILABLE',
  // The write may have reached the bank before the answer was lost: never sent again; a lookup, the debit or a person resolves it.
  'CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN',
  // The provider or the bank refused the instruction for good; providerCode says why.
  'CONNECTOR_PAYMENTS_REFUSED',
  // The bank does not know this payment, basket or authorisation.
  'CONNECTOR_PAYMENTS_NOT_FOUND',
  // The provider failed or could not be reached on a read or a cancel; trying again later may help.
  'CONNECTOR_PAYMENTS_PROVIDER_FAILED',
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
  // The account information provider is not configured or not usable at the service (certificate, credentials): an operator must act.
  'CONNECTOR_AIS_PROVIDER_UNAVAILABLE',
  // A consent or authorisation may have been created before the answer was lost; creating another is harmless.
  'CONNECTOR_AIS_OUTCOME_UNKNOWN',
  // The provider or the bank refused the request for good; providerCode says why.
  'CONNECTOR_AIS_REFUSED',
  // The bank does not know this consent, account or authorisation.
  'CONNECTOR_AIS_NOT_FOUND',
  // The provider failed or could not be reached; trying again later may help.
  'CONNECTOR_AIS_PROVIDER_FAILED',
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

/** A Swedish organisationsnummer as the bank reports it: 10 digits, no separator (a 12-digit form has its century prefix dropped). */
const bankOrgNumberSchema = z.string().regex(/^\d{10}$/, 'organisationsnummer: 10 digits')

/**
 * One payment inside a Bankgirot deposit or payout (2026-10-15). A bankgiro
 * deposit is one row on the statement and stays one row in `transactions`;
 * the bank's per-payer split rides along as the row's `parts`, in the order
 * the bank listed them, so the ledger can settle several invoices from one
 * deposit. Amounts are signed like the parent row (deposit parts positive,
 * payout parts negative).
 */
export const bankTransactionPartSchema = z.object({
  amount: z.number(),
  currency: z.string(),
  /** The payer (a deposit) or the payee (a payout). */
  counterparty_name: z.string().nullable(),
  counterparty_org_number: bankOrgNumberSchema.nullable(),
  /** Bankgiro, plusgiro, BBAN or IBAN, as the bank gave it. */
  counterparty_account: z.string().nullable(),
  /** The structured reference (OCR first), when the part carries one. */
  reference: z.string().nullable(),
  /** The referred documents' numbers (invoice numbers, CINV and others), deduplicated; [] when none. */
  invoice_numbers: z.array(z.string()),
  /** The unstructured message, when the part carries one. */
  message: z.string().nullable(),
  /** The bank's own id for the part (transaction id, else entry reference). */
  provider_part_id: z.string().nullable(),
})
export type BankTransactionPart = z.infer<typeof bankTransactionPartSchema>

export const normalizedBankTransactionSchema = z.object({
  /** A real calendar date: the installation's stored keys and ledger date derive from it. */
  booking_date: z.iso.date(),
  amount: z.number(),
  currency: z.string(),
  description: z.string(),
  counterparty_name: z.string().nullable(),
  counterparty_account: z.string().nullable(),
  /** The structured payment reference (OCR), when the bank sends one. */
  reference: z.string().nullable(),
  /** The card merchant category code (4 digits), when the bank sends one; the AIS family fills it since 2026-10-15. */
  merchant_category_code: z.string().nullable(),
  bank_transaction_code: z.string().nullable(),
  proprietary_bank_transaction_code: z.string().nullable(),
  // Optional: a service older than these fields does not send them, and a
  // required field would refuse its whole sync. The AIS family (2026-10-12)
  // adds the end-to-end id and the counterparty IBAN; the Enable Banking path
  // leaves them out.
  /** The date the money moved, when the bank sends one. */
  value_date: z.iso.date().nullable().optional(),
  /** The end-to-end id a payment order was sent with: how the debit is matched to the order. Never a NOTPROVIDED placeholder. */
  end_to_end_id: z.string().nullable().optional(),
  /** The bank's own id for the transaction (entry reference, else transaction id). */
  provider_transaction_id: z.string().nullable().optional(),
  /** The counterparty's IBAN on its own, when the bank gave one. */
  counterparty_iban: z.string().nullable().optional(),
  /** Index into `raw_pages` of the page this row arrived in. */
  raw_page_index: z.number().int().min(0).nullable().optional(),
  // Optional, added 2026-10-15 (the AIS family's enrichment): what the bank
  // reports beyond the statement line. Null when the bank sends nothing.
  /** The counterparty's organisationsnummer (10 digits): the payer of a deposit, the payee of a payout when the bank names one. */
  counterparty_org_number: bankOrgNumberSchema.nullable().optional(),
  /** The amount in the currency the payment was made in, when that is not the account currency (a card purchase abroad). */
  instructed_amount: z.number().nullable().optional(),
  /** The currency of `instructed_amount`. */
  instructed_currency: z.string().regex(/^[A-Z]{3}$/).nullable().optional(),
  /** The bank's rate from `instructed_currency` to the account currency. */
  exchange_rate: z.number().positive().nullable().optional(),
  /** The account balance after this row, as the bank reports it; never for a personal account (usage PRIV). */
  balance_after: z.number().nullable().optional(),
  /** The bank's own enrichment flag (data sourced beyond PSD2); null when the bank sends none. */
  is_enriched: z.boolean().nullable().optional(),
  /** The Bankgirot per-payer split of this row; null when the bank sent no split, never []. */
  parts: z.array(bankTransactionPartSchema).nullable().optional(),
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

/** The bank's transaction enrichment for one account, per sync (2026-10-15). */
export const bankSyncEnrichmentSchema = z.object({
  /** The account's latest enrichment moment as the bank reports it (ISO 8601); null when it reports none. */
  last_enriched_at: z.string().nullable(),
  /** True when `last_enriched_at` falls on or after the window's last day: the rows of that day carry today's enrichment. */
  window_enriched: z.boolean(),
})
export type BankSyncEnrichment = z.infer<typeof bankSyncEnrichmentSchema>

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
  // Added 2026-10-12 with the AIS family (syncTransactions); the Enable
  // Banking sync leaves them out.
  /** The page cap was reached before the bank ran out of pages: the window is incomplete, ask again with a later date_from. */
  truncated: z.boolean().optional(),
  /** The bank handed back a continuation key it had already given; paging stopped there. */
  pagingLoop: z.boolean().optional(),
  /** Rows dropped as exact repeats of a row already read (same id, booking date and amount). */
  duplicates: z.number().int().min(0).optional(),
  /** Rows kept although their id was already used by a row with another date or amount. */
  conflicts: z.number().int().min(0).optional(),
  // Added 2026-10-15 with the AIS family's enrichment; the Enable Banking
  // sync leaves it out.
  /**
   * Where the bank's own transaction enrichment stands for this account:
   * `last_enriched_at` is the account's latest enrichment moment (ISO 8601,
   * UTC when the bank gives it), `window_enriched` whether it falls on or
   * after the window's last day (so the rows of that day carry today's
   * enrichment). Null when the bank reports no enrichment moment.
   */
  enrichment: bankSyncEnrichmentSchema.nullable().optional(),
})
export type BankSyncResponse = z.infer<typeof bankSyncResponseSchema>

/**
 * Error codes specific to the bank sync operation. Two of them are the
 * BANK's 429 (never the service's own budget, CONNECTOR_RATE_LIMITED), both
 * retryable, both with a Retry-After:
 * - CONNECTOR_BANK_RATE_LIMITED: the bank's allowance for the day is spent
 *   (the bank proxy: the bank's 429 with its Retry-After header when it sent
 *   one; AIS: the consent's reads per day, ACCESS_EXCEEDED at the provider,
 *   Retry-After until the bank's next day). No more today.
 * - CONNECTOR_BANK_THROTTLED: the bank or the provider is throttling for the
 *   moment (BANK_REQUEST_LIMIT_EXCEEDED, any other 429); Retry-After is a
 *   short wait and the read may be tried again today.
 */
export const BANK_SYNC_ERROR_CODES = [
  'CONNECTOR_BANK_SESSION_EXPIRED',
  'CONNECTOR_BANK_UPSTREAM_ERROR',
  'CONNECTOR_BANK_RATE_LIMITED',
  'CONNECTOR_BANK_THROTTLED',
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

// ---------------------------------------------------------------------------
// Payments (bank payments and BankID signing through a payment initiation
// provider; milestone 1 of the connections plan)
// ---------------------------------------------------------------------------

/**
 * The payments family: the installation's payment orders (lib/payments/orders)
 * send one provider-neutral operation per bank interaction, and the service
 * forwards it to the payment initiation provider with Accounted's credentials
 * and client certificate. The service stores no instruction, payee, amount or
 * person: writes leave only an idempotency row (key, sha256 of the body, the
 * provider's ids and the first answer, 30 days), reads leave metering.
 *
 * - Every call is a POST with a JSON body and carries X-Connector-Company.
 * - Every call carries the party: who pays, from which bank, who signs. The
 *   service forwards it as the provider's PSU headers and never keeps it.
 * - Writes (PAYMENTS_WRITE_OPERATIONS) carry an idempotency key. The service
 *   answers a retry with the first result; a write whose outcome was lost is
 *   answered with CONNECTOR_PAYMENTS_OUTCOME_UNKNOWN on every retry and is
 *   never sent to the provider again (a payment API may have no idempotency).
 * - Amounts are numbers in the instruction's currency; the service formats
 *   them for the wire.
 * - Status values are the installation's payment order lifecycle; the
 *   provider's own code travels beside them verbatim (providerStatus).
 * - Bankgiro Lookup (2026-10-16, PAYMENTS_LOOKUP_OPERATIONS): two reads on a
 *   premium product of the provider, asked before a person signs a payment to
 *   an account the company never paid, when a supplier's giro is saved, and
 *   when the company sets up its own invoice payee. They involve no PSU
 *   consent and count against no consent cap or daily read budget (only the
 *   service's own payments budget); every call may cost the provider's
 *   premium fee, so the installation gates them behind its own flag. The
 *   party is the lighter paymentsLookupPartySchema: the company's
 *   organisationsnummer (PSU-Corporate-ID, which the provider requires in the
 *   corporate context) and the signer's personnummer when known (PSU-ID); no
 *   bank is involved. When the provider refuses the premium scope or the
 *   endpoint, the answer is a typed `{ available: false, reason }`, never an
 *   error envelope: a lookup that cannot be made must not stop a payment.
 */

/** Base path of the payments family. */
export const PAYMENTS_BASE_PATH = '/api/connect/payments'

/** Scope a connector key needs for the payments family. */
export const PAYMENTS_SCOPE = 'payments'

/** Every write carries one: a row id from the installation's own database, so a retry reuses it by construction. */
const paymentsIdempotencyKeySchema = z.string().trim().min(1).max(128)

/** A calendar date, `YYYY-MM-DD`. */
const paymentsIsoDateSchema = z.iso.date()

const paymentsBicSchema = z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/, 'BIC: 8 or 11 characters')

/** A Swedish organisationsnummer, 10 digits, no separator. */
const paymentsOrgNumberSchema = z.string().regex(/^\d{10}$/, 'organisationsnummer: 10 digits')

export const paymentsAccountContextSchema = z.enum(['corporate', 'private'])
export type PaymentsAccountContext = z.infer<typeof paymentsAccountContextSchema>

/**
 * PSU-Authoriser-ID: the person's logon id at a bank that identifies the
 * signer by one besides BankID (Nordea Corporate Netbank: the user's logon id
 * there). 1 to 64 letters, digits, `-` or `_`, trimmed. The service sends it
 * ONLY on the authorisation calls (starting, choosing the method and polling
 * a BankID signing), never on a create, a read, a status or a cancel, and
 * never stores it. A second signatory of a partially authorised consent
 * sends their own.
 */
export const psuAuthoriserIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'PSU-Authoriser-ID: 1 to 64 letters, digits, - or _')

/**
 * Who pays, from which bank, and who signs. Sent with every payments call and
 * forwarded to the provider as PSU headers; the service never stores it.
 * `signerPersonalNumber` is the signer's personnummer (12 digits) when the
 * installation knows it; banks use it to address the BankID.
 * `affiliatedAspspId` names the savings bank behind a shared BIC (Swedbank's
 * sparbanker, Ölands Bank), as the AIS `bank` operation lists them in
 * `affiliates`; without it a person with accounts in several of them is
 * refused (PSU_ACCOUNT_MULTIPLE_AFFILIATED_BANKS). Sent as
 * X-AffiliatedASPSP-ID on every payment, basket, status, cancel and signing
 * call. `redirectPreferred` (default false) asks the bank for redirect-based
 * SCA (its own page) over decoupled BankID when it offers both: sent as
 * TPP-Redirect-Preferred when the payment or basket is created; the signing
 * calls take it from the chosen method instead. `psuAuthoriserId`
 * (2026-10-17, psuAuthoriserIdSchema) goes on the signing calls only.
 */
export const paymentsPartySchema = z.object({
  orgNumber: paymentsOrgNumberSchema,
  accountContext: paymentsAccountContextSchema,
  debtorBic: paymentsBicSchema,
  signerPersonalNumber: z.string().regex(/^\d{12}$/, 'personnummer: 12 digits').nullable(),
  psuIpAddress: z.string().max(64).nullable(),
  psuUserAgent: z.string().max(300).nullable(),
  affiliatedAspspId: z.string().trim().min(1).max(64).nullable().optional(),
  redirectPreferred: z.boolean().optional(),
  psuAuthoriserId: psuAuthoriserIdSchema.nullable().optional(),
})
export type PaymentsParty = z.infer<typeof paymentsPartySchema>

const paymentsPayeeNameSchema = z.string().trim().min(1).max(140)

export const paymentsPayeeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bankgiro'), bankgiro: z.string().trim().min(1).max(20), name: paymentsPayeeNameSchema }),
  z.object({ type: z.literal('plusgiro'), plusgiro: z.string().trim().min(1).max(20), name: paymentsPayeeNameSchema }),
  z.object({
    type: z.literal('bank_account'),
    clearing: z.string().trim().min(1).max(10),
    account: z.string().trim().min(1).max(20),
    name: paymentsPayeeNameSchema,
  }),
  z.object({ type: z.literal('iban'), iban: z.string().trim().min(1).max(34), bic: paymentsBicSchema.nullable(), name: paymentsPayeeNameSchema }),
])
export type PaymentsPayee = z.infer<typeof paymentsPayeeSchema>

export const paymentsInstructionSchema = z.object({
  /** The installation's id for the payment at the bank; the debit on the statement carries it. */
  endToEndId: z.string().trim().min(1).max(35),
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/),
  requestedExecutionDate: paymentsIsoDateSchema,
  debtor: z.object({ iban: z.string().trim().min(1).max(34).nullable(), bban: z.string().trim().min(1).max(34).nullable(), currency: z.string().regex(/^[A-Z]{3}$/) }),
  payee: paymentsPayeeSchema,
  reference: z.object({ type: z.enum(['ocr', 'message']), value: z.string().trim().min(1).max(140) }),
})
export type PaymentsInstruction = z.infer<typeof paymentsInstructionSchema>

/** The installation's payment order lifecycle (lib/payments/orders/status.ts); the service maps the provider's codes onto it. */
export const paymentsStatusSchema = z.enum([
  'draft',
  'approved',
  'submitted',
  'awaiting_signature',
  'awaiting_second_signer',
  'accepted',
  'executed',
  'rejected',
  'cancelled',
  'failed',
])
export type PaymentsStatus = z.infer<typeof paymentsStatusSchema>

export const paymentsStateSchema = z.object({
  /** The provider's own status code, verbatim. */
  providerStatus: z.string(),
  status: paymentsStatusSchema,
  /** Provider message codes worth showing or logging (codes, never prose). */
  messages: z.array(z.string()),
})
export type PaymentsState = z.infer<typeof paymentsStateSchema>

export const paymentsCreatedSchema = paymentsStateSchema.extend({
  providerPaymentId: z.string().min(1),
  /** The provider's payment product the instruction was sent as (swedish-giro, domestic, ...). */
  product: z.string().min(1),
  /** The payee name as it went to the bank, when the provider shortened or transliterated it. */
  sentPayeeName: z.string().nullable(),
})
export type PaymentsCreated = z.infer<typeof paymentsCreatedSchema>

export const paymentsSigningTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('payment'), providerPaymentId: z.string().min(1), product: z.string().min(1) }),
  z.object({ kind: z.literal('basket'), providerBasketId: z.string().min(1) }),
])
export type PaymentsSigningTarget = z.infer<typeof paymentsSigningTargetSchema>

export const paymentsSigningMethodSchema = z.enum(['same_device', 'qr', 'redirect'])
export type PaymentsSigningMethod = z.infer<typeof paymentsSigningMethodSchema>

// Redirect signing (the bank's own page)
//
// Some banks sign only on their own page (Lunar, Danske, Revolut, Northmill,
// Skandia, and others that prefer it). A signing start (AIS
// `startConsentSigning`, payments `startSigning`) with method 'redirect'
// carries `returnUrl` (https, on the installation's own origin as the
// connector key pins it) and `returnState` (1 to 128 characters, opaque to
// the service, echoed back verbatim), and answers the usual started shape:
// state 'pending' and a challenge with approach 'redirect' and `redirectUrl`
// filled (the provider's sign-in page; autostartToken, qrData and qrImage
// null). The installation sends the person's browser there. The flow then
// runs without the installation:
//
//   1. the person signs at the bank;
//   2. the bank sends the browser to the service's callback,
//      CONNECTIONS_CALLBACK_PATH on the connect origin (the redirect URI
//      whitelisted at the provider; never the installation's);
//   3. the service exchanges the single-use code where the client secret
//      lives, then answers 302 to `returnUrl` with the query of
//      signingReturnQuerySchema: `state` (the returnState), `result` ('ok'
//      or 'error') and, with 'error', `code` (the OAuth error, for example
//      access_denied when the person cancelled, or the provider's code of
//      the refused exchange; never prose);
//   4. the installation polls the signing (pollConsentSigning, pollSigning)
//      exactly as for decoupled BankID. `result=ok` means the exchange went
//      through OR its answer was lost after it may have reached the
//      provider: the poll tells the truth either way, so the installation
//      never trusts the return alone.
//
// A return whose state the service does not know, or knows as used (the
// state is single use and lives 15 minutes), is answered with a plain page
// in Swedish asking the person to go back to Accounted and try again; the
// installation sees nothing, and its poll ends by timing out.

export const CONNECTIONS_CALLBACK_PATH = '/api/connections/callback'
export const CONNECTIONS_CALLBACK_URL = `${DEFAULT_CONNECT_BASE_URL}${CONNECTIONS_CALLBACK_PATH}`

/** Where the person's browser is sent after signing on the bank's page: https, on the installation's origin. */
export const signingReturnUrlSchema = z.url({ protocol: /^https$/ }).max(2048)
/** The installation's own handle of the signing, echoed back verbatim as `state`. Opaque to the service. */
export const signingReturnStateSchema = z.string().min(1).max(128)
export const signingReturnResultSchema = z.enum(['ok', 'error'])
export type SigningReturnResult = z.infer<typeof signingReturnResultSchema>

/** The query the browser carries to `returnUrl` after the callback. */
export const signingReturnQuerySchema = z.object({
  state: signingReturnStateSchema,
  result: signingReturnResultSchema,
  /** With result 'error': the OAuth error (access_denied, code_missing) or the provider's code for a refused exchange. */
  code: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .optional(),
})
export type SigningReturnQuery = z.infer<typeof signingReturnQuerySchema>

/** The return fields of a signing start: required with method 'redirect', absent otherwise. */
const signingReturnFields = {
  returnUrl: signingReturnUrlSchema.optional(),
  returnState: signingReturnStateSchema.optional(),
}

function requireReturnForRedirect(value: { method: string; returnUrl?: string; returnState?: string }, ctx: z.RefinementCtx): void {
  if (value.method !== 'redirect') return
  if (!value.returnUrl) ctx.addIssue({ code: 'custom', path: ['returnUrl'], message: 'required with method redirect' })
  if (!value.returnState) ctx.addIssue({ code: 'custom', path: ['returnState'], message: 'required with method redirect' })
}

/** What a person needs to sign with BankID right now. */
export const paymentsSigningChallengeSchema = z.object({
  /** Signing in the BankID app from our screen (decoupled) or on the bank's own page (redirect). */
  approach: z.enum(['decoupled', 'redirect']),
  /** Open the BankID app on this device. */
  autostartToken: z.string().nullable(),
  /** Animated QR: the data changes on every poll and must be re-rendered. */
  qrData: z.string().nullable(),
  /** The same QR as a base64 PNG, when the bank offered only that. */
  qrImage: z.string().nullable(),
  /** The bank's page, for the redirect approach; null when no redirect target was given. */
  redirectUrl: z.string().nullable(),
})
export type PaymentsSigningChallenge = z.infer<typeof paymentsSigningChallengeSchema>

export const paymentsSigningStateSchema = z.enum(['pending', 'finalised', 'failed'])

export const paymentsSigningProgressSchema = z.object({
  state: paymentsSigningStateSchema,
  challenge: paymentsSigningChallengeSchema.nullable(),
  /** Provider code when the signing failed (a cancelled or expired BankID, missing rights, redirect only). */
  failureCode: z.string().nullable(),
  /**
   * The bank's SCA status as Open Payments reports it (authenticationStarted,
   * authoriseCreditorAccountStarted, started, ...): which step of a signing in
   * several BankID steps the person is at. Absent from older connectors.
   */
  scaStatus: z.string().nullable().optional(),
})
export type PaymentsSigningProgress = z.infer<typeof paymentsSigningProgressSchema>

export const paymentsSigningStartedSchema = paymentsSigningProgressSchema.extend({
  providerAuthorisationId: z.string().min(1),
  /** The method the bank actually offered (it may impose redirect). */
  method: paymentsSigningMethodSchema,
})
export type PaymentsSigningStarted = z.infer<typeof paymentsSigningStartedSchema>

/** Only 'cancelled' means the payment is gone; every other answer leaves it where it was. */
export const paymentsCancelOutcomeSchema = z.enum(['cancelled', 'needs_authorisation', 'too_late', 'not_cancelled'])
export type PaymentsCancelOutcome = z.infer<typeof paymentsCancelOutcomeSchema>

export const paymentsCancelResultSchema = z.object({
  outcome: paymentsCancelOutcomeSchema,
  providerStatus: z.string().nullable(),
})
export type PaymentsCancelResult = z.infer<typeof paymentsCancelResultSchema>

/** How a bank lets a person sign, asked before anything is created. */
export const paymentsBankCapabilitiesSchema = z.object({
  bic: paymentsBicSchema,
  name: z.string(),
  /** BankID in our screen: a QR code, or the app on this device. */
  decoupled: z.boolean(),
  /** Signing on the bank's own page. */
  redirect: z.boolean(),
  /** Several payments under one BankID, and how many at most (null = no stated limit). */
  basket: z.object({ supported: z.boolean(), maxPayments: z.number().int().positive().nullable() }),
  /** Bankgiro and PlusGiro payments (the swedish-giro product). */
  swedishGiro: z.boolean(),
})
export type PaymentsBankCapabilities = z.infer<typeof paymentsBankCapabilitiesSchema>

/** Know-your-customer status of a company at the provider; payments are refused until valid. */
export const paymentsVerificationSchema = z.object({
  status: z.enum(['valid', 'invalid', 'unknown']),
  validUntil: paymentsIsoDateSchema.nullable(),
  /** The provider's own word, verbatim. */
  providerStatus: z.string().nullable(),
})
export type PaymentsVerification = z.infer<typeof paymentsVerificationSchema>

// Requests

export const paymentsBankRequestSchema = z.object({ bic: paymentsBicSchema })
export type PaymentsBankRequest = z.infer<typeof paymentsBankRequestSchema>

export const paymentsVerificationRequestSchema = z.object({ orgNumber: paymentsOrgNumberSchema })
export type PaymentsVerificationRequest = z.infer<typeof paymentsVerificationRequestSchema>

export const paymentsVerificationStartRequestSchema = z.object({
  orgNumber: paymentsOrgNumberSchema,
  countryCode: z.string().regex(/^[A-Z]{2}$/).default('SE'),
})
export type PaymentsVerificationStartRequest = z.infer<typeof paymentsVerificationStartRequestSchema>

export const paymentsVerificationStartSchema = z.object({ url: z.url() })
export type PaymentsVerificationStart = z.infer<typeof paymentsVerificationStartSchema>

export const paymentsCreateRequestSchema = z.object({
  idempotencyKey: paymentsIdempotencyKeySchema,
  party: paymentsPartySchema,
  instruction: paymentsInstructionSchema,
})
export type PaymentsCreateRequest = z.infer<typeof paymentsCreateRequestSchema>

export const paymentsStatusRequestSchema = z.object({
  party: paymentsPartySchema,
  providerPaymentId: z.string().min(1),
  product: z.string().min(1),
})
export type PaymentsStatusRequest = z.infer<typeof paymentsStatusRequestSchema>

export const paymentsCancelRequestSchema = z.object({
  idempotencyKey: paymentsIdempotencyKeySchema,
  party: paymentsPartySchema,
  providerPaymentId: z.string().min(1),
  product: z.string().min(1),
})
export type PaymentsCancelRequest = z.infer<typeof paymentsCancelRequestSchema>

export const paymentsBasketRequestSchema = z.object({
  idempotencyKey: paymentsIdempotencyKeySchema,
  party: paymentsPartySchema,
  providerPaymentIds: z.array(z.string().min(1)).min(1).max(600),
})
export type PaymentsBasketRequest = z.infer<typeof paymentsBasketRequestSchema>

export const paymentsBasketSchema = z.object({ providerBasketId: z.string().min(1) })
export type PaymentsBasket = z.infer<typeof paymentsBasketSchema>

export const paymentsBasketStatusRequestSchema = z.object({
  party: paymentsPartySchema,
  providerBasketId: z.string().min(1),
})
export type PaymentsBasketStatusRequest = z.infer<typeof paymentsBasketStatusRequestSchema>

export const paymentsSigningStartRequestSchema = z
  .object({
    idempotencyKey: paymentsIdempotencyKeySchema,
    party: paymentsPartySchema,
    target: paymentsSigningTargetSchema,
    /** Decoupled BankID (same_device, qr) or the bank's own page (redirect, with returnUrl and returnState; see "Redirect signing"). */
    method: paymentsSigningMethodSchema,
    ...signingReturnFields,
  })
  .superRefine(requireReturnForRedirect)
export type PaymentsSigningStartRequest = z.infer<typeof paymentsSigningStartRequestSchema>

export const paymentsSigningPollRequestSchema = z.object({
  party: paymentsPartySchema,
  target: paymentsSigningTargetSchema,
  providerAuthorisationId: z.string().min(1),
  method: paymentsSigningMethodSchema,
})
export type PaymentsSigningPollRequest = z.infer<typeof paymentsSigningPollRequestSchema>

// Bankgiro Lookup (premium reads, 2026-10-16)

/** The giro type as the provider names it. */
export const paymentsGiroTypeSchema = z.enum(['BANKGIRO', 'PLUSGIRO'])
export type PaymentsGiroType = z.infer<typeof paymentsGiroTypeSchema>

/**
 * The party of a lookup: no bank, no account. The organisationsnummer is
 * forwarded as PSU-Corporate-ID (mandatory in the corporate context), the
 * signer's personnummer as PSU-ID when the installation knows it. Never
 * stored at the service.
 */
export const paymentsLookupPartySchema = paymentsPartySchema.pick({ orgNumber: true, signerPersonalNumber: true })
export type PaymentsLookupParty = z.infer<typeof paymentsLookupPartySchema>

/** A bankgiro or plusgiro number as the provider takes it: digits and dashes, 5 to 35 characters. */
const paymentsGiroNumberSchema = z.string().trim().regex(/^[0-9-]{5,35}$/, 'giro number: digits and dashes, 5 to 35 characters')

export const paymentsCreditorLookupRequestSchema = z.object({
  party: paymentsLookupPartySchema,
  giroNumber: paymentsGiroNumberSchema,
  giroType: paymentsGiroTypeSchema,
  /** The OCR reference of the invoice about to be paid: the creditor's OCR check is run on it when given. */
  ocrRef: z.string().trim().regex(/^\d{2,25}$/, 'OCR reference: 2 to 25 digits').optional(),
  /** A free reference (the invoice number) when the payment carries no OCR. */
  invoiceRef: z.string().trim().min(1).max(25).optional(),
})
export type PaymentsCreditorLookupRequest = z.infer<typeof paymentsCreditorLookupRequestSchema>

/**
 * Why a lookup has no answer: `premium_not_enabled` (the provider refused the
 * premium product or its scope for this service; an operator decides whether
 * to buy it), `provider_refused` (the provider failed or refused the request;
 * the provider's words are logged at the service), `not_found` (the provider
 * knows no such giro number, or no registration for the company).
 */
export const PAYMENTS_LOOKUP_UNAVAILABLE_REASONS = ['premium_not_enabled', 'provider_refused', 'not_found'] as const
export const paymentsLookupUnavailableReasonSchema = z.enum(PAYMENTS_LOOKUP_UNAVAILABLE_REASONS)
export type PaymentsLookupUnavailableReason = z.infer<typeof paymentsLookupUnavailableReasonSchema>

const paymentsLookupUnavailableSchema = z.object({
  available: z.literal(false),
  reason: paymentsLookupUnavailableReasonSchema,
})

/** A provider message on a successful lookup, verbatim: the code (OCR_REF_INVALID, ...) and its text when the provider sent one. */
export const paymentsLookupWarningSchema = z.object({ code: z.string(), text: z.string().nullable() })

export const paymentsCreditorLookupSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    /** The name Bankgirot has registered for the giro number. */
    creditorName: z.string(),
    /** With an ocrRef: whether the creditor accepts it; null when no ocrRef was given (nothing to check). */
    ocrValid: z.boolean().nullable(),
    warnings: z.array(paymentsLookupWarningSchema),
  }),
  paymentsLookupUnavailableSchema,
])
export type PaymentsCreditorLookup = z.infer<typeof paymentsCreditorLookupSchema>

export const paymentsGiroNumbersRequestSchema = z.object({ party: paymentsLookupPartySchema })
export type PaymentsGiroNumbersRequest = z.infer<typeof paymentsGiroNumbersRequestSchema>

export const paymentsRegisteredGiroSchema = z.object({
  /** As the provider gives it (digits, possibly with a dash). */
  number: z.string(),
  type: z.enum(['bankgiro', 'plusgiro']),
  /** The name registered for the number, when the provider gives one. */
  name: z.string().nullable(),
})
export type PaymentsRegisteredGiro = z.infer<typeof paymentsRegisteredGiroSchema>

export const paymentsGiroNumbersSchema = z.discriminatedUnion('available', [
  z.object({
    available: z.literal(true),
    /** The giro numbers registered to the party's organisation; [] when it has none. */
    giroNumbers: z.array(paymentsRegisteredGiroSchema),
  }),
  paymentsLookupUnavailableSchema,
])
export type PaymentsGiroNumbers = z.infer<typeof paymentsGiroNumbersSchema>

/**
 * The operation table: method, path under PAYMENTS_BASE_PATH, whether the
 * call carries X-Connector-Company, and the request and response schemas.
 * Every operation is a POST so that the party never travels in a URL.
 */
export const PAYMENTS_OPERATIONS = {
  bank: { method: 'POST', path: '/bank', company: true, request: paymentsBankRequestSchema, response: paymentsBankCapabilitiesSchema },
  verification: { method: 'POST', path: '/verification', company: true, request: paymentsVerificationRequestSchema, response: paymentsVerificationSchema },
  startVerification: { method: 'POST', path: '/verification/start', company: true, request: paymentsVerificationStartRequestSchema, response: paymentsVerificationStartSchema },
  createPayment: { method: 'POST', path: '/payments', company: true, request: paymentsCreateRequestSchema, response: paymentsCreatedSchema },
  paymentStatus: { method: 'POST', path: '/payments/status', company: true, request: paymentsStatusRequestSchema, response: paymentsStateSchema },
  cancelPayment: { method: 'POST', path: '/payments/cancel', company: true, request: paymentsCancelRequestSchema, response: paymentsCancelResultSchema },
  createBasket: { method: 'POST', path: '/baskets', company: true, request: paymentsBasketRequestSchema, response: paymentsBasketSchema },
  basketStatus: { method: 'POST', path: '/baskets/status', company: true, request: paymentsBasketStatusRequestSchema, response: paymentsStateSchema },
  startSigning: { method: 'POST', path: '/signings', company: true, request: paymentsSigningStartRequestSchema, response: paymentsSigningStartedSchema },
  pollSigning: { method: 'POST', path: '/signings/poll', company: true, request: paymentsSigningPollRequestSchema, response: paymentsSigningProgressSchema },
  lookupCreditor: { method: 'POST', path: '/creditor-lookup', company: true, request: paymentsCreditorLookupRequestSchema, response: paymentsCreditorLookupSchema },
  lookupGiroNumbers: { method: 'POST', path: '/giro-numbers', company: true, request: paymentsGiroNumbersRequestSchema, response: paymentsGiroNumbersSchema },
} as const
export type PaymentsOperation = keyof typeof PAYMENTS_OPERATIONS

/** Writes: they carry an idempotency key and are never sent to the provider twice. */
export const PAYMENTS_WRITE_OPERATIONS = ['createPayment', 'cancelPayment', 'createBasket', 'startSigning'] as const satisfies readonly PaymentsOperation[]

/**
 * Bankgiro Lookup reads (2026-10-16): premium at the provider, no PSU consent
 * involved, counted against no consent cap or daily read budget, answered
 * with a typed `available: false` when the provider refuses them.
 */
export const PAYMENTS_LOOKUP_OPERATIONS = ['lookupCreditor', 'lookupGiroNumbers'] as const satisfies readonly PaymentsOperation[]

// ---------------------------------------------------------------------------
// AIS (bank reading through an account information provider: consents,
// BankID, accounts, balances, booked transactions; milestone 1 of the
// connections plan)
// ---------------------------------------------------------------------------

/**
 * The AIS family: the installation's bank connections send one
 * provider-neutral operation per bank interaction, and the service forwards
 * it to the account information provider with Accounted's credentials and
 * client certificate. The service keeps no account, balance, row or person:
 * a consent leaves an ownership row (a sha256 of the consent id, the
 * company reference, the account uids it covers) and a per-day read count;
 * everything else leaves metering.
 *
 * - Every call is a POST with a JSON body and carries X-Connector-Company.
 * - Every call but `banks` and `bank` carries the party: whose accounts,
 *   at which bank, who signs. The service forwards it as the provider's PSU
 *   headers and never keeps it.
 * - A consent is created, then signed with BankID (decoupled: QR or this
 *   device; or on the bank's own page: method 'redirect', see "Redirect
 *   signing" above), then read. Repeating a create or a signing start only
 *   makes another consent or authorisation, which is harmless, so AIS
 *   writes carry no idempotency key.
 * - Banks allow four unattended reads per account and day, spread over the
 *   day. The service counts `balances` and `syncTransactions` calls without
 *   a person present (psuIpAddress null) per consent and account, and
 *   `accounts` calls per consent, and answers the fifth with
 *   CONNECTOR_BANK_RATE_LIMITED and a Retry-After until midnight in Sweden.
 *   A read with the person present (psuIpAddress set) is not counted.
 * - `syncTransactions` answers in the bank sync shape (bankSyncResponseSchema)
 *   so an installation ingests this feed and the Enable Banking one the same
 *   way. Since 2026-10-15 it also carries what the bank reports beyond the
 *   statement line (the row's `parts`, `counterparty_org_number`,
 *   `merchant_category_code`, `instructed_amount` / `instructed_currency` /
 *   `exchange_rate`, `balance_after` for a company account, `is_enriched`)
 *   and, when the request sets `include_enrichment`, the account's
 *   `enrichment` moment, read once from the account's details (an extra
 *   provider call; `include_enrichment` says when the installation asks);
 *   otherwise `enrichment` is null.
 */

/** Base path of the AIS family. */
export const AIS_BASE_PATH = '/api/connect/ais'

/** Scope a connector key needs for the AIS family (the same as the bank proxy). */
export const AIS_SCOPE = 'bank_sync'

const aisBicSchema = z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/, 'BIC: 8 or 11 characters')

/** A Swedish organisationsnummer, 10 digits, no separator. */
const aisOrgNumberSchema = z.string().regex(/^\d{10}$/, 'organisationsnummer: 10 digits')

const aisConsentIdSchema = z.string().trim().min(1).max(128)
const aisAccountUidSchema = z.string().trim().min(1).max(128)
const aisIbanSchema = z.string().trim().min(1).max(34)

/**
 * Whose accounts, at which bank, and who signs. Sent with every AIS call and
 * forwarded to the provider as PSU headers; the service never stores it.
 * `personalNumber` is the signer's personnummer (12 digits) when the
 * installation knows it. `psuIpAddress` set means a person is present: the
 * read is not counted against the consent's daily budget. `affiliatedAspspId`
 * names the savings bank behind a shared BIC (Swedbank's sparbanker, Ölands
 * Bank); the `bank` operation lists them as `affiliates`. `redirectPreferred`
 * (default false) asks the bank for redirect-based SCA (its own page) over
 * decoupled BankID when it offers both: sent as TPP-Redirect-Preferred when
 * the consent is created; the signing calls take it from the chosen method
 * instead. `psuAuthoriserId` (2026-10-17, psuAuthoriserIdSchema) goes on the
 * consent's signing calls only (start and poll), never on the consent's
 * creation, its status or a read.
 */
export const aisPartySchema = z.object({
  orgNumber: aisOrgNumberSchema,
  accountContext: paymentsAccountContextSchema,
  bic: aisBicSchema,
  personalNumber: z.string().regex(/^\d{12}$/, 'personnummer: 12 digits').nullable(),
  psuIpAddress: z.string().max(64).nullable(),
  psuUserAgent: z.string().max(300).nullable(),
  affiliatedAspspId: z.string().trim().min(1).max(64).nullable().optional(),
  redirectPreferred: z.boolean().optional(),
  psuAuthoriserId: psuAuthoriserIdSchema.nullable().optional(),
})
export type AisParty = z.infer<typeof aisPartySchema>

/** One bank in the catalogue; signing details are null until `bank` is asked. */
export const aisBankSchema = z.object({
  bic: aisBicSchema,
  name: z.string(),
  logoUrl: z.string().nullable(),
  /** BankID in our screen (QR or this device); null when not known from the list. */
  decoupled: z.boolean().nullable(),
  /** Signing on the bank's own page; null when not known from the list. */
  redirect: z.boolean().nullable(),
})
export type AisBank = z.infer<typeof aisBankSchema>

export const aisBanksRequestSchema = z.object({ country: z.literal('SE').optional() })
export type AisBanksRequest = z.infer<typeof aisBanksRequestSchema>

export const aisBanksResponseSchema = z.object({ banks: z.array(aisBankSchema) })
export type AisBanksResponse = z.infer<typeof aisBanksResponseSchema>

export const aisBankRequestSchema = z.object({ bic: aisBicSchema })
export type AisBankRequest = z.infer<typeof aisBankRequestSchema>

/** One bank's reading capabilities: how a person signs, how far back it serves history, and the banks reached through it. */
export const aisBankDetailsSchema = z.object({
  bic: aisBicSchema,
  name: z.string(),
  decoupled: z.boolean().nullable(),
  redirect: z.boolean().nullable(),
  /** Days of history on an ordinary read; null when the bank does not say. */
  transactionHistoryMaxDays: z.number().int().min(0).nullable(),
  /** Days of history right after the consent was signed (Swedbank: 760) ... */
  extendedTransactionHistoryMaxDays: z.number().int().min(0).nullable(),
  /** ... for this many minutes (Swedbank: 60); afterwards transactionHistoryMaxDays applies. */
  extendedTransactionHistoryAvailableWindowMinutes: z.number().int().min(0).nullable(),
  /** Savings banks behind this BIC; the chosen one goes in the party's affiliatedAspspId. */
  affiliates: z.array(z.object({ id: z.string().min(1), name: z.string() })),
})
export type AisBankDetails = z.infer<typeof aisBankDetailsSchema>

export const aisCreateConsentRequestSchema = z.object({
  party: aisPartySchema,
  /** The consent's last day; default today plus 180 days. The bank may clamp it (read validUntil back). */
  validUntil: z.iso.date().optional(),
  /** Name the accounts the consent covers (a bank that lists accounts first and consents to the chosen ones second); default every account. */
  accounts: z.array(z.object({ iban: aisIbanSchema })).max(100).optional(),
  /**
   * The active consent (same company, same key) this one replaces. The service
   * keeps it live, outside the company's quota, until the new one is valid,
   * then ends it. A consent the service no longer holds makes this a plain
   * creation. Ignored by a service that predates the field.
   */
  replacesConsentId: aisConsentIdSchema.optional(),
  /**
   * The PSU-ID the replaced consent was created with, when it differs from
   * the party's (another signatory renews): several banks want that same
   * number on every call to a consent, its delete included. Absent: the
   * party's personalNumber. Never kept in the clear by the service.
   */
  replacedPersonalNumber: z.string().regex(/^\d{12}$/, 'personnummer: 12 digits').nullable().optional(),
})
export type AisCreateConsentRequest = z.infer<typeof aisCreateConsentRequestSchema>

export const aisConsentCreatedSchema = z.object({
  consentId: z.string().min(1),
  /** The provider's own consent status, verbatim (received until signed). */
  consentStatus: z.string(),
  validUntil: z.iso.date(),
})
export type AisConsentCreated = z.infer<typeof aisConsentCreatedSchema>

export const aisStartConsentSigningRequestSchema = z
  .object({
    party: aisPartySchema,
    consentId: aisConsentIdSchema,
    /** Decoupled BankID (same_device, qr) or the bank's own page (redirect, with returnUrl and returnState; see "Redirect signing"). */
    method: paymentsSigningMethodSchema,
    ...signingReturnFields,
  })
  .superRefine(requireReturnForRedirect)
export type AisStartConsentSigningRequest = z.infer<typeof aisStartConsentSigningRequestSchema>

export const aisConsentSigningStartedSchema = z.object({
  providerAuthorisationId: z.string().min(1),
  /** The method the bank actually offered. A bank that imposes redirect when a decoupled method was asked fails the signing: SCA_REDIRECT_UNSUPPORTED. */
  method: paymentsSigningMethodSchema,
  state: z.enum(['pending', 'failed']),
  challenge: paymentsSigningChallengeSchema.nullable(),
  failureCode: z.string().nullable(),
  /** The bank's SCA status as the provider reports it. */
  scaStatus: z.string().nullable(),
})
export type AisConsentSigningStarted = z.infer<typeof aisConsentSigningStartedSchema>

export const aisPollConsentSigningRequestSchema = z.object({
  party: aisPartySchema,
  consentId: aisConsentIdSchema,
  providerAuthorisationId: z.string().min(1),
  method: paymentsSigningMethodSchema,
})
export type AisPollConsentSigningRequest = z.infer<typeof aisPollConsentSigningRequestSchema>

/**
 * Where a signing stands. `valid`: the consent can be read. `partially_authorised`:
 * this signature went through and another signatory must sign (joint
 * signing), never a failure. `failed`: failureCode says why.
 */
export const aisConsentSigningStateSchema = z.enum(['pending', 'valid', 'partially_authorised', 'failed'])
export type AisConsentSigningState = z.infer<typeof aisConsentSigningStateSchema>

export const aisConsentSigningProgressSchema = z.object({
  state: aisConsentSigningStateSchema,
  /** The current challenge while pending (the QR data changes on every poll). */
  challenge: paymentsSigningChallengeSchema.nullable(),
  failureCode: z.string().nullable(),
  scaStatus: z.string().nullable(),
  /** The provider's own consent status once BankID finished, verbatim (valid, partiallyAuthorised, ...). */
  consentStatus: z.string().nullable(),
  /** The consent's last day as the bank recorded it, once valid. */
  validUntil: z.iso.date().nullable(),
})
export type AisConsentSigningProgress = z.infer<typeof aisConsentSigningProgressSchema>

export const aisConsentStatusRequestSchema = z.object({ party: aisPartySchema, consentId: aisConsentIdSchema })
export type AisConsentStatusRequest = z.infer<typeof aisConsentStatusRequestSchema>

/** `over`: expired, revoked by the person, rejected or ended by us; only a new consent helps. */
export const aisConsentStateSchema = z.enum(['pending', 'valid', 'partially_authorised', 'over'])
export type AisConsentState = z.infer<typeof aisConsentStateSchema>

export const aisConsentStatusSchema = z.object({
  /** The provider's own consent status, verbatim. */
  consentStatus: z.string(),
  state: aisConsentStateSchema,
  validUntil: z.iso.date().nullable(),
})
export type AisConsentStatus = z.infer<typeof aisConsentStatusSchema>

export const aisAccountsRequestSchema = z.object({
  party: aisPartySchema,
  consentId: aisConsentIdSchema,
  /** Default true. */
  withBalance: z.boolean().optional(),
})
export type AisAccountsRequest = z.infer<typeof aisAccountsRequestSchema>

/**
 * One account of a consent, as an installation needs it to pick and name
 * accounts. The signer's own accounts (usage PRIV), which a corporate
 * consent can list, carry no balance and no owner name.
 */
export const aisAccountSchema = z.object({
  uid: aisAccountUidSchema,
  currency: z.string().regex(/^[A-Z]{3}$/),
  iban: z.string().nullable(),
  bban: z.string().nullable(),
  name: z.string().nullable(),
  /** ORGA (the company's), PRIV (the signer's own), or null when the bank does not say. */
  usage: z.string().nullable(),
  ownerName: z.string().nullable(),
  bankgiro: z.string().nullable(),
  plusgiro: z.string().nullable(),
  balance: z.number().nullable(),
  availableBalance: z.number().nullable(),
})
export type AisAccount = z.infer<typeof aisAccountSchema>

export const aisAccountsResponseSchema = z.object({ accounts: z.array(aisAccountSchema) })
export type AisAccountsResponse = z.infer<typeof aisAccountsResponseSchema>

export const aisBalancesRequestSchema = z.object({
  party: aisPartySchema,
  consentId: aisConsentIdSchema,
  accountUid: aisAccountUidSchema,
})
export type AisBalancesRequest = z.infer<typeof aisBalancesRequestSchema>

export const aisBalancesSchema = z.object({
  booked: z.number().nullable(),
  available: z.number().nullable(),
})
export type AisBalances = z.infer<typeof aisBalancesSchema>

export const aisSyncTransactionsRequestSchema = z.object({
  party: aisPartySchema,
  consentId: aisConsentIdSchema,
  accountUid: aisAccountUidSchema,
  accountCurrency: z.string().regex(/^[A-Z]{3}$/),
  /** The account's usage as `accounts` reported it; PRIV keeps no running balance in the rows or the archived pages. */
  accountUsage: z.string().max(16).optional(),
  dateFrom: z.iso.date(),
  /** Default today. */
  dateTo: z.iso.date().optional(),
  /**
   * Added 2026-10-15. True: the service reads the account details once and
   * answers `enrichment` (the bank's last enrichment time and whether the
   * window carries it). False or absent: `enrichment` is null and no extra
   * provider call is made. The ledger asks only when its stored
   * last_enriched_at is missing or older than today's UTC date, and never
   * for a sync a person triggered, so an account costs at most one details
   * read a day on top of its transaction reads.
   */
  include_enrichment: z.boolean().optional(),
})
export type AisSyncTransactionsRequest = z.infer<typeof aisSyncTransactionsRequestSchema>

export const aisRevokeConsentRequestSchema = z.object({ party: aisPartySchema, consentId: aisConsentIdSchema })
export type AisRevokeConsentRequest = z.infer<typeof aisRevokeConsentRequestSchema>

export const aisConsentRevokedSchema = z.object({ revoked: z.literal(true) })
export type AisConsentRevoked = z.infer<typeof aisConsentRevokedSchema>

/**
 * The operation table: method, path under AIS_BASE_PATH, whether the call
 * carries X-Connector-Company, and the request and response schemas. Every
 * operation is a POST so that the party never travels in a URL.
 */
export const AIS_OPERATIONS = {
  banks: { method: 'POST', path: '/banks', company: true, request: aisBanksRequestSchema, response: aisBanksResponseSchema },
  bank: { method: 'POST', path: '/bank', company: true, request: aisBankRequestSchema, response: aisBankDetailsSchema },
  createConsent: { method: 'POST', path: '/consents', company: true, request: aisCreateConsentRequestSchema, response: aisConsentCreatedSchema },
  startConsentSigning: { method: 'POST', path: '/consents/signings', company: true, request: aisStartConsentSigningRequestSchema, response: aisConsentSigningStartedSchema },
  pollConsentSigning: { method: 'POST', path: '/consents/signings/poll', company: true, request: aisPollConsentSigningRequestSchema, response: aisConsentSigningProgressSchema },
  consentStatus: { method: 'POST', path: '/consents/status', company: true, request: aisConsentStatusRequestSchema, response: aisConsentStatusSchema },
  accounts: { method: 'POST', path: '/accounts', company: true, request: aisAccountsRequestSchema, response: aisAccountsResponseSchema },
  balances: { method: 'POST', path: '/accounts/balances', company: true, request: aisBalancesRequestSchema, response: aisBalancesSchema },
  syncTransactions: { method: 'POST', path: '/sync', company: true, request: aisSyncTransactionsRequestSchema, response: bankSyncResponseSchema },
  revokeConsent: { method: 'POST', path: '/consents/revoke', company: true, request: aisRevokeConsentRequestSchema, response: aisConsentRevokedSchema },
} as const
export type AisOperation = keyof typeof AIS_OPERATIONS

/** Reads that count against the consent's daily budget when no person is present (psuIpAddress null). */
export const AIS_COUNTED_READ_OPERATIONS = ['accounts', 'balances', 'syncTransactions'] as const satisfies readonly AisOperation[]

/**
 * Error codes specific to the AIS family, beside CONNECTOR_BANK_SESSION_EXPIRED
 * (410: the consent is over, a new one is needed), CONNECTOR_BANK_RATE_LIMITED
 * (429: the consent's daily read budget, ours or the bank's, is spent;
 * Retry-After until the bank's next day) and CONNECTOR_BANK_THROTTLED (429:
 * the bank or the provider throttles for the moment; a short Retry-After)
 * from BANK_SYNC_ERROR_CODES.
 */
export const AIS_ERROR_CODES = [
  'CONNECTOR_AIS_PROVIDER_UNAVAILABLE',
  'CONNECTOR_AIS_OUTCOME_UNKNOWN',
  'CONNECTOR_AIS_REFUSED',
  'CONNECTOR_AIS_NOT_FOUND',
  'CONNECTOR_AIS_PROVIDER_FAILED',
] as const satisfies readonly ConnectorErrorCode[]

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
  /**
   * A private debtor's identity number, sent whenever the installation has
   * it. Optional on a handover (the provider then finds the person by name
   * and postal address) and on a delivery by post; required for the delivery
   * methods that reach a person by it. In transit only, never logged.
   */
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

/**
 * Identity rules a handover enforces (kept off the object schema so it stays
 * extendable): a Swedish business needs its org number. A private person's
 * identity number is sent whenever the installation has it, but a handover
 * without one is valid: the provider finds the person by name and postal
 * address, so a consumer is never refused for lacking it.
 */
function checkDebtorIdentity(debtor: CollectionsDebtor, ctx: IssueSink, path: PropertyKey[]): void {
  if (debtor.address?.countryCode !== 'SE') return
  if (debtor.kind === 'business' && debtor.orgNumber === null) {
    ctx.addIssue({ code: 'custom', message: 'a business debtor in SE needs orgNumber', path: [...path, 'orgNumber'] })
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
  /**
   * The owner's personnummer: a sole trader may send it or null, a company
   * sends null. In transit only. A sole trader (enskild firma) onboards as a
   * business with its ten-digit `orgNumber`, so an installation need not send
   * the owner's number at all.
   */
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

// ---------------------------------------------------------------------------
// Spend (installation -> service, /api/connect/spend/*)
// ---------------------------------------------------------------------------

/**
 * Company card and spend platforms: expenses a person approved and coded at
 * the provider (account, VAT code, dimensions), each with its receipt files,
 * delivered to the installation for booking. One provider-neutral family;
 * which providers exist is answered at runtime (`providers`), never named
 * here. Conventions:
 *
 * - The service holds the integrator credential and the company's grant at
 *   the provider (OAuth tokens, or an API key the provider issued to the
 *   company). The installation never sees either: it keeps the connection
 *   handle `complete` or `connectKey` returned and sends it as
 *   SPEND_CONNECTION_HEADER. The service keeps only its hash and refuses a
 *   handle bound to another key or company (CONNECTOR_CONNECTION_NOT_OWNED).
 * - Connecting through the provider's consent page is a browser round trip.
 *   `authorize` answers with the consent URL, built on the service's own
 *   registered redirect URI; the provider sends the browser back to the
 *   service, which exchanges the code and returns the browser to the
 *   installation's `returnUrl` with `state` (the installation's own) and
 *   `result` (opaque). The installation finishes with `complete`, server to
 *   server. `returnUrl` must be on the connector key's instance.
 * - The service refuses a connection whose provider company carries a
 *   Swedish registration number other than `orgNumber`
 *   (CONNECTOR_SPEND_COMPANY_MISMATCH): one provider company per ledger
 *   company, never another entity's spend in these books.
 * - The provider decides when expenses are ready: a person exports them
 *   there. `expenses` returns what waits for the connection, oldest first.
 *   Every expense is answered with `acknowledge`: received (the installation
 *   holds it for booking; a person books it later) or rejected with a code
 *   and a reason in Swedish, which the provider shows its user. An expense
 *   left unanswered for SPEND_ACK_DEADLINE_SECONDS is rejected by the
 *   service so the provider's own deadline never lapses silently; the person
 *   exports it again and it returns under the same `externalId`, which the
 *   installation treats as the same expense.
 * - Amounts are numbers in `currency` (the wallet's), rounded to two
 *   decimals by the service, signed from the company's side: positive is
 *   money out of the wallet or owed to the person (a purchase, an utlägg),
 *   negative is money back (a refund, a chargeback, cashback). Lines carry
 *   the expense side only; the counter side is the installation's to choose
 *   from `kind`. Where `lines` is not empty, the service guarantees that
 *   their amounts sum to `amount`.
 * - Codes on lines (`account`, `vat.code`, dimension and value codes) are the
 *   installation's own, as it published them with `masterData`: the service
 *   passes them through and never translates them.
 * - `raw` is the provider's answer for the expense verbatim, which the
 *   installation archives (BFL 7 kap) and never parses.
 * - Receipt files are copied from the provider by the service when the
 *   expense is first offered, and kept only until it is acknowledged and at
 *   most SPEND_FILE_RETENTION_DAYS. `files[].downloadUrl` is a short-lived
 *   https link to that copy, renewed on every `expenses` call; the
 *   installation stores the file itself before it acknowledges.
 * - Writes at the provider: `masterData` (the installation's accounts, VAT
 *   codes and dimensions, reconciled into the provider: created, renamed,
 *   archived, never deleted) and `acknowledge` (each expense's outcome).
 *   Nothing else in this family writes at the provider.
 */
export const SPEND_BASE_PATH = '/api/connect/spend'

/** The connector key scope that opens this family. */
export const SPEND_SCOPE = 'spend'

/** The connection handle header; the same name the other families use. */
export const SPEND_CONNECTION_HEADER = CONNECTOR_HEADERS.connection

/** In characters: the provider's answer for one expense, verbatim. */
export const SPEND_MAX_RAW_CHARS = 200_000

/** An expense not acknowledged this long after it was first offered is rejected by the service. */
export const SPEND_ACK_DEADLINE_SECONDS = 45 * 60

/** The longest the service keeps its copy of a receipt file. */
export const SPEND_FILE_RETENTION_DAYS = 7

/** The most expenses one `expenses` call answers with. */
export const SPEND_EXPENSES_PAGE_MAX = 50

/** The most outcomes one `acknowledge` call takes. */
export const SPEND_ACK_MAX = 100

const spendRefSchema = z.string().trim().min(1).max(128)
/** An account number or VAT code as the installation published it. */
const spendCodeSchema = z.string().trim().min(1).max(32)
const spendDimensionCodeSchema = z.string().trim().min(1).max(40)
const spendAmountSchema = z.number().finite()
const spendSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, 'lower-case hex sha256')
/** A link back to the installation: https, or http on a local instance. */
const spendInstanceUrlSchema = z.url({ protocol: /^https?$/ }).max(512)

export const SPEND_CONNECT_MODES = ['oauth', 'api_key'] as const
export const spendConnectModeSchema = z.enum(SPEND_CONNECT_MODES)
export type SpendConnectMode = z.infer<typeof spendConnectModeSchema>

/** A spend provider as the installation shows it. */
export const spendProviderSchema = z.object({
  /** Stable opaque slug; the installation stores it on its connection. */
  ref: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(80),
  legalName: z.string().trim().min(1).max(200).nullable(),
  portalUrl: httpsUrlSchema.nullable(),
  supportUrl: httpsUrlSchema.nullable(),
  /** How a company connects: the provider's consent page, an API key the provider issues, or both. */
  connectModes: z.array(spendConnectModeSchema).min(1),
  /** The most dimensions the provider takes from `masterData`; the rest are left out. */
  maxDimensions: z.number().int().min(0).max(20),
  /** What a person does at the provider after connecting (map categories, the wallet account), in Swedish. Null when nothing. */
  setupNoteSv: z.string().max(4000).nullable(),
})
export type SpendProvider = z.infer<typeof spendProviderSchema>

export const spendProvidersResponseSchema = z.object({
  /** Providers this key may connect. */
  providers: z.array(spendProviderSchema),
  serverTime: z.string(),
})
export type SpendProvidersResponse = z.infer<typeof spendProvidersResponseSchema>

export const spendAuthorizeRequestSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  orgNumber: orgNumberSchema,
  /** Where the service sends the browser after the provider's consent page. On the key's instance. */
  returnUrl: spendInstanceUrlSchema,
  /** The installation's own CSRF state, returned unchanged. */
  state: z.string().trim().min(16).max(200),
})
export type SpendAuthorizeRequest = z.infer<typeof spendAuthorizeRequestSchema>

export const spendAuthorizeResponseSchema = z.object({
  /** The provider's consent page; open it in the person's browser. */
  authorizeUrl: httpsUrlSchema,
  /** The consent must be finished before this moment. */
  expiresAt: z.string(),
})
export type SpendAuthorizeResponse = z.infer<typeof spendAuthorizeResponseSchema>

export const spendCompleteRequestSchema = z.object({
  state: z.string().trim().min(16).max(200),
  /** The opaque `result` the service put on the return URL. */
  result: z.string().trim().min(16).max(256),
})
export type SpendCompleteRequest = z.infer<typeof spendCompleteRequestSchema>

export const spendConnectKeyRequestSchema = z.object({
  provider: z.string().trim().min(1).max(64),
  orgNumber: orgNumberSchema,
  /** The API key the provider issued to the company. In transit only: the service stores it encrypted and never returns it. */
  apiKey: z.string().trim().min(8).max(512),
})
export type SpendConnectKeyRequest = z.infer<typeof spendConnectKeyRequestSchema>

export const spendConnectionSchema = z.object({
  /** Opaque and secret-free; the installation stores it and sends it as SPEND_CONNECTION_HEADER. A new connect rotates it. */
  connectionHandle: z.string().min(16).max(256),
  provider: spendProviderSchema,
  mode: spendConnectModeSchema,
  /** The provider's own id of the connected company. */
  providerCompanyRef: spendRefSchema,
  providerCompanyName: z.string().trim().min(1).max(200).nullable(),
  /** The company's registration number as the provider holds it, digits only; null when it holds none. */
  providerOrgNumber: z.string().regex(/^\d{6,20}$/).nullable(),
  connectedAt: z.string(),
})
export type SpendConnection = z.infer<typeof spendConnectionSchema>

export const spendIssueSchema = z.object({
  /** Stable, machine readable; the installation decides what each code means for booking. */
  code: z.string().trim().min(1).max(64),
  message: z.string().max(500),
})
export type SpendIssue = z.infer<typeof spendIssueSchema>

export const spendStatusResponseSchema = z.object({
  /** reconnect_required: the grant at the provider is gone (revoked, expired); a person connects again. */
  state: z.enum(['active', 'reconnect_required', 'provider_error']),
  detail: z.string().max(500).nullable(),
  /** Expenses offered and not yet acknowledged. */
  waitingExpenses: z.number().int().min(0),
  /** When the provider last handed over a batch of expenses. */
  lastBatchAt: z.string().nullable(),
  masterData: z.object({
    receivedAt: z.string().nullable(),
    appliedAt: z.string().nullable(),
    state: z.enum(['none', 'pending', 'applied', 'failed']),
    issues: z.array(spendIssueSchema).max(50),
  }),
  serverTime: z.string(),
})
export type SpendStatusResponse = z.infer<typeof spendStatusResponseSchema>

/** standard: the VAT is included in the amount; reverse: none was charged and the buyer accounts for it. */
export const SPEND_VAT_TYPES = ['standard', 'reverse'] as const
export const spendVatTypeSchema = z.enum(SPEND_VAT_TYPES)
export type SpendVatType = z.infer<typeof spendVatTypeSchema>

export const spendMasterAccountSchema = z.object({
  number: spendCodeSchema,
  name: z.string().trim().min(1).max(200),
  /** The account's usual VAT code (one of `vatCodes`); a hint for the provider, never applied by the service. */
  vatCode: spendCodeSchema.nullable(),
})
export type SpendMasterAccount = z.infer<typeof spendMasterAccountSchema>

export const spendVatCodeSchema = z.object({
  /** Upper case letters, digits and underscore; matched without regard to case at the provider. */
  code: z.string().regex(/^[A-Z0-9_]{1,32}$/),
  /** Shown to the people coding expenses at the provider. */
  name: z.string().trim().min(1).max(100),
  type: spendVatTypeSchema,
  /** As a fraction: 0.25 for 25 %. */
  rate: z.number().min(0).max(1),
  /** For a reverse code: the accounts the buyer books the VAT on, for the provider's display. Null otherwise. */
  inputVatAccount: spendCodeSchema.nullable(),
  outputVatAccount: spendCodeSchema.nullable(),
})
export type SpendVatCode = z.infer<typeof spendVatCodeSchema>

export const spendDimensionSchema = z.object({
  code: spendDimensionCodeSchema,
  name: z.string().trim().min(1).max(100),
  values: z.array(z.object({ code: spendDimensionCodeSchema, name: z.string().trim().min(1).max(200) })).max(10_000),
})
export type SpendDimension = z.infer<typeof spendDimensionSchema>

/**
 * The installation's coding vocabulary, in full every time: the service
 * reconciles the provider to it (creates, renames, archives what is no longer
 * sent; never deletes). Dimensions beyond the provider's maxDimensions are
 * left out, in the order sent.
 */
export const spendMasterDataRequestSchema = z.object({
  idempotencyKey: idempotencyKeySchema,
  accounts: z.array(spendMasterAccountSchema).max(11_000),
  vatCodes: z.array(spendVatCodeSchema).max(100),
  dimensions: z.array(spendDimensionSchema).max(20),
})
export type SpendMasterDataRequest = z.infer<typeof spendMasterDataRequestSchema>

export const spendMasterDataResponseSchema = z.object({
  accepted: z.literal(true),
  /** applied: the provider already reflects it; pending: the service applies it shortly (status reports the outcome). */
  state: z.enum(['pending', 'applied']),
})
export type SpendMasterDataResponse = z.infer<typeof spendMasterDataResponseSchema>

/**
 * What an expense is, from the company's side. The installation chooses the
 * counter side of the voucher from it:
 *
 * - card_purchase, card_invoice, fee, refund, chargeback, cashback: on the
 *   wallet (the provider's account holding the company's money);
 * - out_of_pocket, mileage, per_diem: owed to the person (an utlägg or a
 *   kostnadsersättning);
 * - reimbursement: the provider paid the person back from the wallet;
 * - external_reimbursement: the person was paid back outside the provider;
 * - wallet_topup, wallet_unload: money between the company's bank and the
 *   wallet;
 * - atm_withdrawal, personal_spend: cash or a private purchase on the card;
 * - invoice, invoice_payment: a supplier invoice registered or paid through
 *   the provider;
 * - balance_adjustment: the provider's own correction of the wallet;
 * - other: a type the service does not recognise, with an issue.
 */
export const SPEND_EXPENSE_KINDS = [
  'card_purchase',
  'card_invoice',
  'fee',
  'refund',
  'chargeback',
  'cashback',
  'out_of_pocket',
  'mileage',
  'per_diem',
  'reimbursement',
  'external_reimbursement',
  'wallet_topup',
  'wallet_unload',
  'atm_withdrawal',
  'personal_spend',
  'invoice',
  'invoice_payment',
  'balance_adjustment',
  'other',
] as const
export const spendExpenseKindSchema = z.enum(SPEND_EXPENSE_KINDS)
export type SpendExpenseKind = z.infer<typeof spendExpenseKindSchema>

export const spendExpenseLineSchema = z.object({
  /** The account the line is coded on, as published in masterData; null when the provider has none. */
  account: spendCodeSchema.nullable(),
  /** In `currency`, VAT included, signed like the expense. */
  amount: spendAmountSchema,
  vat: z
    .object({
      /** The VAT code as published in masterData; null when the provider sent none. */
      code: spendCodeSchema.nullable(),
      type: spendVatTypeSchema,
      rate: z.number().min(0).max(1),
      /** The VAT inside `amount` as the provider states it (the receipt's), or the reverse charge it computed; null when it states none. */
      amount: spendAmountSchema.nullable(),
    })
    .nullable(),
  /** Dimension code to value code, as published in masterData. */
  dimensions: z.record(spendDimensionCodeSchema, spendDimensionCodeSchema),
  description: z.string().max(500).nullable(),
})
export type SpendExpenseLine = z.infer<typeof spendExpenseLineSchema>

export const spendFileSchema = z.object({
  fileRef: spendRefSchema,
  /** The name the provider gave the file, when it has one. */
  name: z.string().trim().min(1).max(255).nullable(),
  contentType: z.string().trim().min(1).max(100),
  /** In bytes. */
  size: z.number().int().min(0),
  sha256: spendSha256Schema,
  /** A short-lived link to the service's copy; renewed on every `expenses` call. */
  downloadUrl: httpsUrlSchema,
  downloadExpiresAt: z.string(),
})
export type SpendFile = z.infer<typeof spendFileSchema>

export const spendAttendeeSchema = z.object({
  name: z.string().trim().min(1).max(200),
  company: z.string().trim().max(200).nullable(),
  /** True for the company's own people. */
  internal: z.boolean(),
})
export type SpendAttendee = z.infer<typeof spendAttendeeSchema>

export const spendExpenseSchema = z.object({
  /** The provider's stable id for the expense; an expense exported again carries the same id. */
  externalId: spendRefSchema,
  /** The provider's batch the expense came in, for the installation's trail only. */
  batchRef: spendRefSchema.nullable(),
  kind: spendExpenseKindSchema,
  /** The provider's own word for a sub type, when it has one. */
  subKind: z.string().trim().min(1).max(64).nullable(),
  /** When the expense happened, as the provider states it. */
  date: isoDateSchema,
  currency: currencyCodeSchema,
  amount: spendAmountSchema,
  /** What the merchant charged, when in another currency than `currency`. */
  original: z.object({ currency: currencyCodeSchema, amount: spendAmountSchema }).nullable(),
  /** The account the provider says holds the wallet, as published in masterData; null when it says none. */
  walletAccount: spendCodeSchema.nullable(),
  lines: z.array(spendExpenseLineSchema).max(100),
  merchant: z
    .object({
      name: z.string().trim().min(1).max(200),
      country: countryCodeSchema.nullable(),
      taxId: z.string().trim().max(64).nullable(),
      /** The card network's merchant category code, when sent. */
      categoryCode: z.string().trim().max(16).nullable(),
    })
    .nullable(),
  /** Who spent or is owed the money. */
  person: z.object({ name: z.string().trim().min(1).max(200), ref: z.string().trim().max(128).nullable() }).nullable(),
  note: z.string().max(2000).nullable(),
  attendees: z.array(spendAttendeeSchema).max(100),
  /** The provider's own reference for reconciliation, printed on the voucher. */
  reference: z.string().trim().max(128).nullable(),
  /** For a reimbursement: the externalIds of the expenses it settles. */
  settles: z.array(spendRefSchema).max(500),
  files: z.array(spendFileSchema).max(20),
  /** The expense at the provider, for people. */
  providerUrl: httpsUrlSchema.nullable(),
  issues: z.array(spendIssueSchema).max(50),
  raw: z.object({
    contentType: z.string().max(100),
    body: z.string().max(SPEND_MAX_RAW_CHARS),
    /** Lower-case hex sha256 of `body` as UTF-8. */
    sha256: spendSha256Schema,
  }),
})
export type SpendExpense = z.infer<typeof spendExpenseSchema>

export const spendExpensesRequestSchema = z.object({
  limit: z.number().int().min(1).max(SPEND_EXPENSES_PAGE_MAX).optional(),
})
export type SpendExpensesRequest = z.infer<typeof spendExpensesRequestSchema>

export const spendExpensesResponseSchema = z.object({
  expenses: z.array(spendExpenseSchema).max(SPEND_EXPENSES_PAGE_MAX),
  /** True when more expenses wait than this answer holds. */
  more: z.boolean(),
  serverTime: z.string(),
})
export type SpendExpensesResponse = z.infer<typeof spendExpensesResponseSchema>

/** Why the installation refused an expense; the service maps each code to the provider's own failure type. */
export const SPEND_REJECTION_CODES = [
  'kind_unsupported',
  'currency_unsupported',
  'amounts_mismatch',
  'account_missing',
  'account_unknown',
  'vat_code_missing',
  'vat_code_unknown',
  'dimension_unknown',
  'wallet_account_unknown',
  'period_locked',
  'receipt_unusable',
  'internal_error',
] as const
export const spendRejectionCodeSchema = z.enum(SPEND_REJECTION_CODES)
export type SpendRejectionCode = z.infer<typeof spendRejectionCodeSchema>

export const spendAckResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    externalId: spendRefSchema,
    outcome: z.literal('received'),
    /** The installation's own id for the expense. */
    ledgerRef: spendRefSchema,
    /** Where a person finds it in the installation; null when it has no public address. */
    ledgerUrl: spendInstanceUrlSchema.nullable(),
  }),
  z.object({
    externalId: spendRefSchema,
    outcome: z.literal('rejected'),
    reasonCode: spendRejectionCodeSchema,
    /** Shown to the provider's user, in Swedish: what to fix there before exporting again. */
    reasonSv: z.string().trim().min(1).max(500),
  }),
])
export type SpendAckResult = z.infer<typeof spendAckResultSchema>

export const spendAcknowledgeRequestSchema = z.object({
  results: z.array(spendAckResultSchema).min(1).max(SPEND_ACK_MAX),
})
export type SpendAcknowledgeRequest = z.infer<typeof spendAcknowledgeRequestSchema>

export const spendAcknowledgeResponseSchema = z.object({
  accepted: z.number().int().min(0),
  /** externalIds the service does not hold as waiting (already answered, or never offered). */
  unknown: z.array(spendRefSchema),
})
export type SpendAcknowledgeResponse = z.infer<typeof spendAcknowledgeResponseSchema>

export const spendDisconnectResponseSchema = z.object({ disconnected: z.literal(true) })

/**
 * The operation table, paths under SPEND_BASE_PATH. `connection` marks the
 * operations that carry SPEND_CONNECTION_HEADER.
 */
export const SPEND_OPERATIONS = {
  providers: { method: 'POST', path: '/providers', company: true, connection: false, request: z.object({}), response: spendProvidersResponseSchema },
  authorize: { method: 'POST', path: '/authorize', company: true, connection: false, request: spendAuthorizeRequestSchema, response: spendAuthorizeResponseSchema },
  complete: { method: 'POST', path: '/complete', company: true, connection: false, request: spendCompleteRequestSchema, response: spendConnectionSchema },
  connectKey: { method: 'POST', path: '/connect-key', company: true, connection: false, request: spendConnectKeyRequestSchema, response: spendConnectionSchema },
  status: { method: 'POST', path: '/status', company: true, connection: true, request: z.object({}), response: spendStatusResponseSchema },
  masterData: { method: 'POST', path: '/master-data', company: true, connection: true, request: spendMasterDataRequestSchema, response: spendMasterDataResponseSchema },
  expenses: { method: 'POST', path: '/expenses', company: true, connection: true, request: spendExpensesRequestSchema, response: spendExpensesResponseSchema },
  acknowledge: { method: 'POST', path: '/acknowledge', company: true, connection: true, request: spendAcknowledgeRequestSchema, response: spendAcknowledgeResponseSchema },
  disconnect: { method: 'POST', path: '/disconnect', company: true, connection: true, request: z.object({}), response: spendDisconnectResponseSchema },
} as const
export type SpendOperation = keyof typeof SPEND_OPERATIONS

/**
 * Error codes of this family, in addition to the shared ones.
 * CONNECTOR_SPEND_RECONNECT_REQUIRED: the grant at the provider is gone and a
 * person connects again. CONNECTOR_SPEND_PROVIDER_RATE_LIMITED is the
 * PROVIDER's 429, answered with its Retry-After.
 */
export const SPEND_ERROR_CODES = [
  'CONNECTOR_CONNECTION_NOT_OWNED',
  'CONNECTOR_SPEND_PROVIDER_UNKNOWN',
  'CONNECTOR_SPEND_MODE_UNSUPPORTED',
  'CONNECTOR_SPEND_COMPANY_MISMATCH',
  'CONNECTOR_SPEND_ALREADY_CONNECTED',
  'CONNECTOR_SPEND_RECONNECT_REQUIRED',
  'CONNECTOR_SPEND_PROVIDER_ACCESS_DENIED',
  'CONNECTOR_SPEND_PROVIDER_RATE_LIMITED',
  'CONNECTOR_SPEND_PROVIDER_ERROR',
] as const
export type SpendErrorCode = (typeof SPEND_ERROR_CODES)[number]
