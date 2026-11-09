/**
 * The Connect adapter for reading a bank (account information): the only
 * route to the account information provider for hosted and self-hosted
 * alike. Accounted Connect holds the provider's credentials and client
 * certificate and serves the AIS family of the contract (AIS_OPERATIONS under
 * AIS_BASE_PATH); this adapter speaks those operations and nothing else.
 *
 *   - One function per operation, typed by the contract's schemas: banks,
 *     bank, createConsent, startConsentSigning, pollConsentSigning,
 *     consentStatus, accounts, balances, syncTransactions, revokeConsent;
 *     plus getBankDetails, the bank operation behind a 24 h in-memory cache
 *     (which signing a bank offers, its history window and its sparbanker
 *     change about never, and the flow asks on every pick).
 *   - Availability: a connector key (aisConnectorMode()) gives the whole
 *     installation an adapter. Which company may read its bank this way is
 *     the door's question (./door.ts), never the adapter's.
 *   - Every failure becomes a typed error the feed and the consent flow
 *     branch on: ConsentOverError (the consent is over, only a new one helps),
 *     RateLimitedError (the consent's daily read budget, ours or the bank's,
 *     with the Retry-After the service sent), BankThrottledError (the bank's
 *     short throttle, Retry-After of about 45 s: a retry in a minute, the
 *     budget untouched), ProviderUnavailableError (the
 *     provider or the service could not answer; later may differ) and
 *     BankFeedRefusedError (a refusal that a retry never fixes, with the
 *     provider's own code when it gave one).
 */

import {
  AIS_OPERATIONS,
  type AisAccount,
  type AisBalances,
  type AisBank,
  type AisBankDetails,
  type AisConsentCreated,
  type AisConsentRevoked,
  type AisConsentSigningProgress,
  type AisConsentSigningStarted,
  type AisConsentStatus,
  type AisOperation,
  type AisParty,
  type AisPollConsentSigningRequest,
  type AisStartConsentSigningRequest,
  type BankSyncResponse,
} from '@accounted/connect-contract'
import { CONNECTOR_UNREACHABLE_CODE, ConnectorCallError, callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { aisConnectorMode, type ConnectorUpstream } from '@/lib/connect/instance/upstreams'

/** Connect's own client timeout is 20 s; wait long enough to hear its answer, its timeout included. */
export const AIS_CONNECT_TIMEOUT_MS = 30_000
/** A transactions read pages through the bank's history; the Enable Banking connector sync allows the same. */
export const AIS_SYNC_TIMEOUT_MS = 120_000
/** How long a bank's details are kept before the service is asked again. */
export const BANK_DETAILS_TTL_MS = 24 * 60 * 60 * 1000

/** The consent is over (expired, revoked, rejected, unknown): only a new consent helps. */
export const BANK_FEED_CONSENT_OVER = 'BANK_FEED_CONSENT_OVER'
/** The daily read budget of the consent is spent (ours or the bank's). */
export const BANK_FEED_RATE_LIMITED = 'BANK_FEED_RATE_LIMITED'
/** The bank is busy for a moment (its short throttle): try again shortly. */
export const BANK_FEED_THROTTLED = 'BANK_FEED_THROTTLED'
/** The bank does not know the consent, account or authorisation. */
export const BANK_FEED_NOT_FOUND = 'BANK_FEED_NOT_FOUND'

export class BankFeedError extends Error {
  readonly code: string
  readonly retryable: boolean
  /** The HTTP status the service answered with; null when no answer arrived. */
  readonly status: number | null
  /** The provider's own code when the service relayed one (CONSENT_INVALID, PSU_RIGHTS_MISSING, ...). */
  readonly providerCode: string | null

  constructor(message: string, options: { code: string; retryable: boolean; status?: number | null; providerCode?: string | null; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'BankFeedError'
    this.code = options.code
    this.retryable = options.retryable
    this.status = options.status ?? null
    this.providerCode = options.providerCode ?? null
  }
}

export class ConsentOverError extends BankFeedError {
  constructor(message: string, options: { status?: number | null; providerCode?: string | null } = {}) {
    super(message, { code: BANK_FEED_CONSENT_OVER, retryable: false, ...options })
    this.name = 'ConsentOverError'
  }
}

export class RateLimitedError extends BankFeedError {
  /** Seconds until the next read may be accepted, when the service said. */
  readonly retryAfterSeconds: number | null
  constructor(message: string, options: { status?: number | null; providerCode?: string | null; retryAfterSeconds?: number | null } = {}) {
    super(message, { code: BANK_FEED_RATE_LIMITED, retryable: true, status: options.status, providerCode: options.providerCode })
    this.name = 'RateLimitedError'
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

/** The bank's short throttle (CONNECTOR_BANK_THROTTLED): too many requests in a moment, not the daily cap. */
export class BankThrottledError extends BankFeedError {
  /** Seconds until the bank accepts the next request, when the service said (about 45). */
  readonly retryAfterSeconds: number | null
  constructor(message: string, options: { status?: number | null; providerCode?: string | null; retryAfterSeconds?: number | null } = {}) {
    super(message, { code: BANK_FEED_THROTTLED, retryable: true, status: options.status, providerCode: options.providerCode })
    this.name = 'BankThrottledError'
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}

export class ProviderUnavailableError extends BankFeedError {
  constructor(message: string, options: { code: string; status?: number | null; providerCode?: string | null; cause?: unknown }) {
    super(message, { ...options, retryable: true })
    this.name = 'ProviderUnavailableError'
  }
}

export class BankFeedRefusedError extends BankFeedError {
  constructor(message: string, options: { code: string; status?: number | null; providerCode?: string | null; cause?: unknown }) {
    super(message, { ...options, retryable: false })
    this.name = 'BankFeedRefusedError'
  }
}

/** What a failed Connect call means for the feed, in the feed's terms. */
export function toBankFeedError(error: unknown, operation: AisOperation): BankFeedError {
  if (error instanceof BankFeedError) return error
  if (!(error instanceof ConnectorCallError)) {
    const message = error instanceof Error ? error.message : String(error)
    return new BankFeedRefusedError(`Connect ais.${operation}: ${message}`, { code: 'CONNECTOR_FAILED', cause: error })
  }
  const status = error.status
  if (status === 410 || error.code === 'CONNECTOR_BANK_SESSION_EXPIRED') {
    return new ConsentOverError(error.message, { status, providerCode: error.providerCode })
  }
  if (error.code === 'CONNECTOR_BANK_RATE_LIMITED') {
    return new RateLimitedError(error.message, { status, providerCode: error.providerCode, retryAfterSeconds: error.retryAfterSeconds })
  }
  if (error.code === 'CONNECTOR_BANK_THROTTLED') {
    return new BankThrottledError(error.message, { status, providerCode: error.providerCode, retryAfterSeconds: error.retryAfterSeconds })
  }
  switch (error.code) {
    case 'CONNECTOR_AIS_NOT_FOUND':
      return new BankFeedRefusedError(error.message, { code: BANK_FEED_NOT_FOUND, status, providerCode: error.providerCode })
    case 'CONNECTOR_AIS_REFUSED':
      return new BankFeedRefusedError(error.message, { code: error.code, status, providerCode: error.providerCode })
    case 'CONNECTOR_AIS_OUTCOME_UNKNOWN':
    case 'CONNECTOR_AIS_PROVIDER_UNAVAILABLE':
    case 'CONNECTOR_AIS_PROVIDER_FAILED':
    // The service could not record the redirect's return state; the start may be tried again.
    case 'CONNECTOR_LEDGER_FAILED':
    case 'CONNECTOR_RATE_LIMITED':
    case CONNECTOR_UNREACHABLE_CODE:
      return new ProviderUnavailableError(error.message, { code: error.code, status, providerCode: error.providerCode, cause: error })
    default:
      break
  }
  if (/^HTTP_(5\d\d|429)$/.test(error.code)) {
    return new ProviderUnavailableError(error.message, { code: error.code, status, cause: error })
  }
  // Configuration, scope, key, contract and request errors: a person or an operator must act.
  return new BankFeedRefusedError(error.message, { code: error.code, status, providerCode: error.providerCode, cause: error })
}

export interface BankFeedConnectDeps {
  fetch?: typeof fetch
  timeoutMs?: number
  syncTimeoutMs?: number
  /** The clock the bank-details cache reads; tests pass their own. */
  now?: () => number
}

/** The AIS family as typed functions; every call carries the company and, where the contract wants one, the party. */
export interface BankFeedConnect {
  banks(companyId: string): Promise<AisBank[]>
  bank(companyId: string, bic: string): Promise<AisBankDetails>
  /** `bank`, answered from the in-memory cache for BANK_DETAILS_TTL_MS. */
  getBankDetails(companyId: string, bic: string): Promise<AisBankDetails>
  createConsent(companyId: string, input: { party: AisParty; validUntil?: string; accounts?: Array<{ iban: string }>; replacesConsentId?: string; replacedPersonalNumber?: string | null }): Promise<AisConsentCreated>
  startConsentSigning(companyId: string, input: AisStartConsentSigningRequest): Promise<AisConsentSigningStarted>
  pollConsentSigning(companyId: string, input: AisPollConsentSigningRequest): Promise<AisConsentSigningProgress>
  consentStatus(companyId: string, input: { party: AisParty; consentId: string }): Promise<AisConsentStatus>
  accounts(companyId: string, input: { party: AisParty; consentId: string; withBalance?: boolean }): Promise<AisAccount[]>
  balances(companyId: string, input: { party: AisParty; consentId: string; accountUid: string }): Promise<AisBalances>
  syncTransactions(
    companyId: string,
    input: { party: AisParty; consentId: string; accountUid: string; accountCurrency: string; accountUsage?: string; dateFrom: string; dateTo?: string },
  ): Promise<BankSyncResponse>
  revokeConsent(companyId: string, input: { party: AisParty; consentId: string }): Promise<AisConsentRevoked>
}

// One cache for the process: getBankFeedConnect() makes a fresh adapter on
// every call, so the memory has to live outside it. Keyed by BIC; a bank's
// details are the same for every company.
const bankDetailsCache = new Map<string, { details: AisBankDetails; expiresAt: number }>()

/** Forget every cached bank: tests, and an operator who knows a bank changed. */
export function clearBankDetailsCache(): void {
  bankDetailsCache.clear()
}

export function createBankFeedConnect(upstream: ConnectorUpstream, deps: BankFeedConnectDeps = {}): BankFeedConnect {
  const timeoutMs = deps.timeoutMs ?? AIS_CONNECT_TIMEOUT_MS
  const syncTimeoutMs = deps.syncTimeoutMs ?? AIS_SYNC_TIMEOUT_MS
  const now = deps.now ?? Date.now

  async function call<O extends AisOperation>(operation: O, companyId: string, body: unknown, timeout = timeoutMs) {
    try {
      return await callConnectorOperation({
        upstream,
        operation: `ais.${operation}`,
        def: AIS_OPERATIONS[operation],
        body,
        companyId,
        timeoutMs: timeout,
        fetch: deps.fetch,
      })
    } catch (error) {
      throw toBankFeedError(error, operation)
    }
  }

  return {
    async banks(companyId) {
      return (await call('banks', companyId, { country: 'SE' })).banks
    },
    bank(companyId, bic) {
      return call('bank', companyId, { bic })
    },
    async getBankDetails(companyId, bic) {
      const key = bic.toUpperCase()
      const cached = bankDetailsCache.get(key)
      if (cached && cached.expiresAt > now()) return cached.details
      const details = await call('bank', companyId, { bic })
      bankDetailsCache.set(key, { details, expiresAt: now() + BANK_DETAILS_TTL_MS })
      return details
    },
    createConsent(companyId, input) {
      return call('createConsent', companyId, input)
    },
    startConsentSigning(companyId, input) {
      return call('startConsentSigning', companyId, input)
    },
    pollConsentSigning(companyId, input) {
      return call('pollConsentSigning', companyId, input)
    },
    consentStatus(companyId, input) {
      return call('consentStatus', companyId, input)
    },
    async accounts(companyId, input) {
      return (await call('accounts', companyId, input)).accounts
    },
    balances(companyId, input) {
      return call('balances', companyId, input)
    },
    syncTransactions(companyId, input) {
      return call('syncTransactions', companyId, input, syncTimeoutMs)
    },
    revokeConsent(companyId, input) {
      return call('revokeConsent', companyId, input)
    },
  }
}

let override: BankFeedConnect | null | undefined

/**
 * The installation's adapter, or null without a connector key. Read on every
 * call so a redeploy with a new key needs no restart of anything else.
 */
export function getBankFeedConnect(): BankFeedConnect | null {
  if (override !== undefined) return override
  const upstream = aisConnectorMode()
  return upstream ? createBankFeedConnect(upstream) : null
}

/** Tests only: a fake adapter (or null for a dark installation); undefined restores the environment-driven one. */
export function setBankFeedConnectForTests(adapter: BankFeedConnect | null | undefined): void {
  override = adapter
}
