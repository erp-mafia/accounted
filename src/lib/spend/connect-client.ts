import {
  CONNECTOR_HEADERS,
  CONTRACT_VERSION,
  SPEND_BASE_PATH,
  SPEND_CONNECTION_HEADER,
  SPEND_OPERATIONS,
  connectorErrorSchema,
  type SpendAckResult,
  type SpendAcknowledgeResponse,
  type SpendAuthorizeResponse,
  type SpendConnection,
  type SpendExpensesResponse,
  type SpendMasterDataRequest,
  type SpendMasterDataResponse,
  type SpendOperation,
  type SpendProvidersResponse,
  type SpendStatusResponse,
} from '@accounted/connect-contract'
import type { z } from 'zod'
import { getConnectorConfig } from '@/lib/connect/instance/config'
import { parseRetryAfterSeconds } from '@/lib/connect/instance/connector-fetch'

/**
 * The ledger's one adapter for the spend capability: Accounted Connect's
 * `spend` family. Provider code lives only in Connect (decided 2026-09-30),
 * so there is no direct adapter: without a connector key
 * (GNUBOK_CONNECTOR_KEY) the capability is simply unavailable, which every
 * caller reports as such.
 *
 * Same transport rules as the POS family (lib/pos-sales/connect-client.ts):
 * the key travels as a bearer token, so the origin must be https; the body
 * is read inside the timeout; every answer is validated against the
 * contract before it is used.
 */

/** Codes this adapter adds for failures the service envelope cannot carry. */
export const SPEND_CONNECT_UNCONFIGURED = 'SPEND_CONNECT_UNCONFIGURED'
export const SPEND_CONNECT_UNREACHABLE = 'SPEND_CONNECT_UNREACHABLE'
export const SPEND_CONNECT_PROTOCOL_ERROR = 'SPEND_CONNECT_PROTOCOL_ERROR'

export class SpendConnectError extends Error {
  readonly name = 'SpendConnectError'
  readonly code: string
  readonly status: number | null
  readonly retryable: boolean
  readonly retryAfterSec: number | null

  constructor(
    message: string,
    options: { code: string; status?: number | null; retryable: boolean; retryAfterSec?: number | null; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.code = options.code
    this.status = options.status ?? null
    this.retryable = options.retryable
    this.retryAfterSec = options.retryAfterSec ?? null
  }
}

/** Connect's routes answer within 60 s; the ledger waits a little longer on the heavy reads. */
const TIMEOUT_MS: Record<SpendOperation, number> = {
  providers: 20_000,
  authorize: 20_000,
  complete: 30_000,
  connectKey: 30_000,
  status: 20_000,
  masterData: 30_000,
  expenses: 65_000,
  acknowledge: 30_000,
  disconnect: 20_000,
}

export interface SpendConnectDeps {
  fetch?: typeof fetch
  /** Overrides the connector configuration (tests). */
  config?: { baseUrl: string; key: string } | null
}

export function isSpendConnectConfigured(deps: SpendConnectDeps = {}): boolean {
  return (deps.config !== undefined ? deps.config : getConnectorConfig()) !== null
}

function retryAfterOf(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds)
  // An HTTP date (RFC 9110 10.2.3): the wait until then, in whole seconds.
  return parseRetryAfterSeconds(header)
}

async function call<T>(
  operation: SpendOperation,
  body: unknown,
  options: { companyId: string; handle?: string },
  deps: SpendConnectDeps,
): Promise<T> {
  const config = deps.config !== undefined ? deps.config : getConnectorConfig()
  if (!config) {
    throw new SpendConnectError('No connector key on this installation', { code: SPEND_CONNECT_UNCONFIGURED, retryable: false })
  }
  let url: URL
  try {
    url = new URL(`${config.baseUrl.replace(/\/+$/, '')}${SPEND_BASE_PATH}${SPEND_OPERATIONS[operation].path}`)
  } catch (err) {
    throw new SpendConnectError('Invalid connector URL', { code: SPEND_CONNECT_UNCONFIGURED, retryable: false, cause: err })
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SpendConnectError('The connector URL must be https', { code: SPEND_CONNECT_UNCONFIGURED, retryable: false })
  }

  const fetchImpl = deps.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS[operation])
  try {
    const response = await fetchImpl(url.toString(), {
      method: SPEND_OPERATIONS[operation].method,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [CONNECTOR_HEADERS.company]: options.companyId,
        [CONNECTOR_HEADERS.contractVersion]: CONTRACT_VERSION,
        ...(options.handle ? { [SPEND_CONNECTION_HEADER]: options.handle } : {}),
      },
      body: JSON.stringify(body ?? {}),
    })
    const text = await response.text()
    let json: unknown = null
    if (text) {
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
    }
    if (!response.ok) {
      const envelope = connectorErrorSchema.safeParse(json)
      const code = envelope.success ? envelope.data.code : `HTTP_${response.status}`
      const retryable = envelope.success && typeof envelope.data.retryable === 'boolean'
        ? envelope.data.retryable
        : response.status === 429 || response.status >= 500
      throw new SpendConnectError(`Connect answered ${response.status} (${code})`, {
        code,
        status: response.status,
        retryable,
        retryAfterSec: retryAfterOf(response),
      })
    }
    const schema = SPEND_OPERATIONS[operation].response as unknown as z.ZodType<T>
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new SpendConnectError(`Connect answered ${operation} in an unexpected shape`, {
        code: SPEND_CONNECT_PROTOCOL_ERROR,
        status: response.status,
        retryable: false,
      })
    }
    return parsed.data
  } catch (err) {
    if (err instanceof SpendConnectError) throw err
    throw new SpendConnectError('Connect could not be reached', { code: SPEND_CONNECT_UNREACHABLE, retryable: true, cause: err })
  } finally {
    clearTimeout(timeout)
  }
}

export function listSpendProviders(companyId: string, deps: SpendConnectDeps = {}): Promise<SpendProvidersResponse> {
  return call<SpendProvidersResponse>('providers', {}, { companyId }, deps)
}

export function authorizeSpend(
  companyId: string,
  input: { provider: string; orgNumber: string; returnUrl: string; state: string },
  deps: SpendConnectDeps = {},
): Promise<SpendAuthorizeResponse> {
  return call<SpendAuthorizeResponse>('authorize', input, { companyId }, deps)
}

export function completeSpendConnect(
  companyId: string,
  input: { state: string; result: string },
  deps: SpendConnectDeps = {},
): Promise<SpendConnection> {
  return call<SpendConnection>('complete', input, { companyId }, deps)
}

export function connectSpendWithKey(
  companyId: string,
  input: { provider: string; orgNumber: string; apiKey: string },
  deps: SpendConnectDeps = {},
): Promise<SpendConnection> {
  return call<SpendConnection>('connectKey', input, { companyId }, deps)
}

export function fetchSpendStatus(companyId: string, handle: string, deps: SpendConnectDeps = {}): Promise<SpendStatusResponse> {
  return call<SpendStatusResponse>('status', {}, { companyId, handle }, deps)
}

export function sendSpendMasterData(
  companyId: string,
  handle: string,
  request: SpendMasterDataRequest,
  deps: SpendConnectDeps = {},
): Promise<SpendMasterDataResponse> {
  return call<SpendMasterDataResponse>('masterData', request, { companyId, handle }, deps)
}

export function fetchSpendExpenses(
  companyId: string,
  handle: string,
  input: { limit?: number } = {},
  deps: SpendConnectDeps = {},
): Promise<SpendExpensesResponse> {
  return call<SpendExpensesResponse>('expenses', input, { companyId, handle }, deps)
}

export function acknowledgeSpendExpenses(
  companyId: string,
  handle: string,
  results: SpendAckResult[],
  deps: SpendConnectDeps = {},
): Promise<SpendAcknowledgeResponse> {
  return call<SpendAcknowledgeResponse>('acknowledge', { results }, { companyId, handle }, deps)
}

export function disconnectSpendConnection(companyId: string, handle: string, deps: SpendConnectDeps = {}): Promise<{ disconnected: true }> {
  return call<{ disconnected: true }>('disconnect', {}, { companyId, handle }, deps)
}

/**
 * Codes after which calling again cannot help until a person acts: the
 * grant at the provider is gone, the key lost its scope or was revoked, or
 * the installation has no key.
 */
export const SPEND_ACTION_REQUIRED_CODES = new Set([
  SPEND_CONNECT_UNCONFIGURED,
  'CONNECTOR_SPEND_RECONNECT_REQUIRED',
  'CONNECTOR_SPEND_PROVIDER_ACCESS_DENIED',
  'CONNECTOR_CONNECTION_NOT_OWNED',
  'CONNECTOR_SCOPE_MISSING',
  'CONNECTOR_KEY_INVALID',
  'CONNECTOR_KEY_MISSING',
  'CONNECTOR_KEY_SUSPENDED',
])
