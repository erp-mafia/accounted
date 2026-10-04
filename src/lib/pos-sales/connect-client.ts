import {
  CONNECTOR_HEADERS,
  POS_CONNECTION_HEADER,
  POS_SALES_BASE_PATH,
  POS_SALES_OPERATIONS,
  connectorErrorSchema,
  type PosConnection,
  type PosDayResponse,
  type PosSalesOperation,
  type PosVenuesResponse,
} from '@accounted/connect-contract'
import type { z } from 'zod'
import { getConnectorConfig } from '@/lib/connect/instance/config'

/**
 * The ledger's one adapter for the POS sales capability: Accounted Connect's
 * `pos` family. Provider code lives only in Connect (decided 2026-09-30), so
 * there is no direct adapter: without a connector key (GNUBOK_CONNECTOR_KEY)
 * the capability is simply unavailable, which every caller reports as such.
 *
 * Same transport rules as the Peppol connector transport
 * (lib/invoices/transports/connector.ts): the key travels as a bearer token,
 * so the origin must be https; the body is read inside the timeout; every
 * answer is validated against the contract before it is used.
 */

/** Codes this adapter adds for failures the service envelope cannot carry. */
export const POS_CONNECT_UNCONFIGURED = 'POS_CONNECT_UNCONFIGURED'
export const POS_CONNECT_UNREACHABLE = 'POS_CONNECT_UNREACHABLE'
export const POS_CONNECT_PROTOCOL_ERROR = 'POS_CONNECT_PROTOCOL_ERROR'

export class PosConnectError extends Error {
  readonly name = 'PosConnectError'
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

/** Connect's route allows 60 s for a day (the provider gets 45 s of it); the ledger waits a little longer. */
const TIMEOUT_MS: Record<PosSalesOperation, number> = {
  venues: 20_000,
  connect: 20_000,
  day: 65_000,
  disconnect: 20_000,
}

export interface PosConnectDeps {
  fetch?: typeof fetch
  /** Overrides the connector configuration (tests). */
  config?: { baseUrl: string; key: string } | null
}

export function isPosConnectConfigured(deps: PosConnectDeps = {}): boolean {
  return (deps.config !== undefined ? deps.config : getConnectorConfig()) !== null
}

function retryAfterOf(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds) : null
}

async function call<T>(
  operation: PosSalesOperation,
  body: unknown,
  options: { companyId: string; handle?: string },
  deps: PosConnectDeps,
): Promise<T> {
  const config = deps.config !== undefined ? deps.config : getConnectorConfig()
  if (!config) {
    throw new PosConnectError('No connector key on this installation', { code: POS_CONNECT_UNCONFIGURED, retryable: false })
  }
  let url: URL
  try {
    url = new URL(`${config.baseUrl.replace(/\/+$/, '')}${POS_SALES_BASE_PATH}${POS_SALES_OPERATIONS[operation].path}`)
  } catch (err) {
    throw new PosConnectError('Invalid connector URL', { code: POS_CONNECT_UNCONFIGURED, retryable: false, cause: err })
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new PosConnectError('The connector URL must be https', { code: POS_CONNECT_UNCONFIGURED, retryable: false })
  }

  const fetchImpl = deps.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS[operation])
  try {
    const response = await fetchImpl(url.toString(), {
      method: POS_SALES_OPERATIONS[operation].method,
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        [CONNECTOR_HEADERS.company]: options.companyId,
        ...(options.handle ? { [POS_CONNECTION_HEADER]: options.handle } : {}),
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
      throw new PosConnectError(`Connect answered ${response.status} (${code})`, {
        code,
        status: response.status,
        retryable,
        retryAfterSec: retryAfterOf(response),
      })
    }
    const schema = POS_SALES_OPERATIONS[operation].response as unknown as z.ZodType<T>
    const parsed = schema.safeParse(json)
    if (!parsed.success) {
      throw new PosConnectError(`Connect answered ${operation} in an unexpected shape`, {
        code: POS_CONNECT_PROTOCOL_ERROR,
        status: response.status,
        retryable: false,
      })
    }
    return parsed.data
  } catch (err) {
    if (err instanceof PosConnectError) throw err
    throw new PosConnectError('Connect could not be reached', { code: POS_CONNECT_UNREACHABLE, retryable: true, cause: err })
  } finally {
    clearTimeout(timeout)
  }
}

export function listPosVenues(companyId: string, orgNumber: string, deps: PosConnectDeps = {}): Promise<PosVenuesResponse> {
  return call<PosVenuesResponse>('venues', { orgNumber }, { companyId }, deps)
}

export function connectPosVenue(
  companyId: string,
  input: { provider: string; venueRef: string; orgNumber: string },
  deps: PosConnectDeps = {},
): Promise<PosConnection> {
  return call<PosConnection>('connect', input, { companyId }, deps)
}

export function fetchPosDay(companyId: string, handle: string, businessDate: string, deps: PosConnectDeps = {}): Promise<PosDayResponse> {
  return call<PosDayResponse>('day', { businessDate }, { companyId, handle }, deps)
}

export function disconnectPosConnection(companyId: string, handle: string, deps: PosConnectDeps = {}): Promise<{ disconnected: true }> {
  return call<{ disconnected: true }>('disconnect', {}, { companyId, handle }, deps)
}

/**
 * Codes after which calling again cannot help until a person acts: the
 * provider has not opened the venue, the grant is gone, the key lost its
 * scope or was revoked, or the installation has no key.
 */
export const POS_ACTION_REQUIRED_CODES = new Set([
  POS_CONNECT_UNCONFIGURED,
  'CONNECTOR_POS_PROVIDER_ACCESS_DENIED',
  'CONNECTOR_POS_VENUE_NOT_GRANTED',
  'CONNECTOR_CONNECTION_NOT_OWNED',
  'CONNECTOR_SCOPE_MISSING',
  'CONNECTOR_KEY_INVALID',
  'CONNECTOR_KEY_MISSING',
  'CONNECTOR_KEY_SUSPENDED',
])
