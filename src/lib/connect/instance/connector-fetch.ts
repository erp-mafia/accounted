import { CONNECTOR_HEADERS, CONTRACT_VERSION, connectorErrorSchema } from '@accounted/connect-contract'
import type { z } from 'zod'
import type { ConnectorUpstream } from './upstreams'

/**
 * The one way an installation addresses Accounted Connect.
 *
 * Every call of every family (bank, Skatteverket, Peppol, the entitlement
 * sync, the catalogue, collections, delivery) carries the caller's contract
 * version in X-Connect-Contract-Version, so the service can accept the
 * current and the previous version and refuse anything older with
 * CONNECTOR_CONTRACT_VERSION_UNSUPPORTED instead of misreading a body.
 *
 * connectorHeaders() is for call sites that build their own fetch (the
 * extension clients keep their proxy-specific headers and error handling);
 * callConnectorOperation() is the whole round trip for a family described by
 * an operation table in the contract (COLLECTIONS_OPERATIONS,
 * DELIVERY_OPERATIONS, CATALOGUE_OPERATIONS).
 */

export const CONTRACT_VERSION_HEADER = CONNECTOR_HEADERS.contractVersion

export interface ConnectorHeaderOptions {
  /** The installation's connector key, sent as a bearer token. */
  key: string
  /** The installation's own company id (X-Connector-Company); omit for key-wide calls. */
  companyId?: string | null
  /** The opaque connection handle a provider capability returned at onboarding (X-Connector-Connection). */
  connectionHandle?: string | null
  /** Add JSON Content-Type and Accept. */
  json?: boolean
}

/** Authorization, contract version and, when given, the company and connection headers. */
export function connectorHeaders(options: ConnectorHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${options.key}`,
    [CONTRACT_VERSION_HEADER]: CONTRACT_VERSION,
  }
  if (options.json) {
    headers['Content-Type'] = 'application/json'
    headers.Accept = 'application/json'
  }
  if (options.companyId) headers[CONNECTOR_HEADERS.company] = options.companyId
  if (options.connectionHandle) headers[CONNECTOR_HEADERS.connection] = options.connectionHandle
  return headers
}

/** Adapter-side codes for failures the service's envelope cannot carry. */
export const CONNECTOR_UNREACHABLE_CODE = 'CONNECTOR_UNREACHABLE'
export const CONNECTOR_PROTOCOL_ERROR_CODE = 'CONNECTOR_PROTOCOL_ERROR'
/** The request failed the contract before it was sent: a caller bug, never retried. */
export const CONNECTOR_REQUEST_INVALID_CODE = 'CONNECTOR_REQUEST_INVALID'
/** A company operation was called without a company. */
export const CONNECTOR_COMPANY_MISSING_CODE = 'CONNECTOR_COMPANY_MISSING'
/** The configured service origin is not https (loopback http excepted). */
export const CONNECTOR_INSECURE_URL_CODE = 'CONNECTOR_INSECURE_URL'

/**
 * A failed connector call. `code` is the service's envelope code (or
 * `HTTP_<status>` when the body is not an envelope, or one of the adapter
 * codes above); `detail` is the service's prose, for logs only.
 */
export class ConnectorCallError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly detail: string | null
  /** The HTTP status the service answered with; null when no answer arrived. */
  readonly status: number | null

  constructor(
    message: string,
    options: { code: string; retryable: boolean; detail?: string | null; status?: number | null; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ConnectorCallError'
    this.code = options.code
    this.retryable = options.retryable
    this.detail = options.detail ?? null
    this.status = options.status ?? null
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * The connector key travels as a bearer token, so the service origin must be
 * https. Plain http is tolerated for loopback only (local development against
 * a dev server), the same rule getConnectorConfig() applies to
 * GNUBOK_CONNECT_URL.
 */
export function assertConnectorUrlSecure(baseUrl: string): void {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new ConnectorCallError('Connector: invalid service URL', { code: CONNECTOR_INSECURE_URL_CODE, retryable: false })
  }
  if (url.protocol === 'https:') return
  if (url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname)) return
  throw new ConnectorCallError('Connector: the service URL must be https (the connector key is a bearer token)', {
    code: CONNECTOR_INSECURE_URL_CODE,
    retryable: false,
  })
}

/** The shape of one row of a contract operation table. */
export interface ConnectorOperationDef {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly path: string
  readonly company: boolean
  readonly request: z.ZodType
  readonly response: z.ZodType
}

export interface ConnectorCallOptions<D extends ConnectorOperationDef> {
  upstream: ConnectorUpstream
  /** Name of the operation, for errors and logs. */
  operation: string
  def: D
  /** Validated against def.request before anything is sent. Ignored for GET. */
  body: unknown
  companyId?: string | null
  connectionHandle?: string | null
  timeoutMs: number
  fetch?: typeof fetch
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return { error: text.slice(0, 500) }
  }
}

function failureFromResponse(operation: string, status: number, body: unknown): ConnectorCallError {
  const parsed = connectorErrorSchema.safeParse(body)
  const envelope = parsed.success ? parsed.data : null
  const retryable = typeof envelope?.retryable === 'boolean' ? envelope.retryable : status === 429 || status >= 500
  return new ConnectorCallError(`Connector ${operation}: ${envelope?.error || `answered ${status}`}`, {
    code: envelope?.code ?? `HTTP_${status}`,
    retryable,
    detail: envelope?.detail ?? null,
    status,
  })
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((i) => `${i.path.join('.')}: ${i.message}`)
    .join('; ')
}

/**
 * One contract operation, end to end: validate the request, send it with the
 * connector headers, read the body inside the timeout window, map a refusal
 * to its envelope code, and validate the answer against the contract. A
 * shape mismatch is a protocol error and never retried; a transport failure
 * (network, timeout, a stalled body) is CONNECTOR_UNREACHABLE and retryable.
 * A timeout is never proof that nothing happened: callers retry writes with
 * the same idempotency key.
 */
export async function callConnectorOperation<D extends ConnectorOperationDef>(
  options: ConnectorCallOptions<D>,
): Promise<z.infer<D['response']>> {
  const { def, operation } = options
  const baseUrl = options.upstream.baseUrl.replace(/\/+$/, '')
  assertConnectorUrlSecure(baseUrl)

  if (def.company && !options.companyId) {
    throw new ConnectorCallError(`Connector ${operation}: a company is required`, {
      code: CONNECTOR_COMPANY_MISSING_CODE,
      retryable: false,
    })
  }

  let payload: string | undefined
  if (def.method !== 'GET') {
    const request = def.request.safeParse(options.body)
    if (!request.success) {
      throw new ConnectorCallError(`Connector ${operation}: the request does not match the contract`, {
        code: CONNECTOR_REQUEST_INVALID_CODE,
        retryable: false,
        detail: issueSummary(request.error),
      })
    }
    payload = JSON.stringify(request.data)
  }

  const fetchImpl = options.fetch ?? globalThis.fetch
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs)
  // The body is read INSIDE the timeout window: headers that arrive and a
  // body that then stalls must not hold the caller forever.
  try {
    const response = await fetchImpl(`${baseUrl}${def.path}`, {
      method: def.method,
      signal: controller.signal,
      // A followed redirect would resend the connector key to its target.
      redirect: 'error',
      cache: 'no-store',
      headers: connectorHeaders({
        key: options.upstream.key,
        companyId: def.company ? options.companyId : null,
        connectionHandle: options.connectionHandle,
        json: true,
      }),
      body: payload,
    })
    const json = await readJson(response)
    if (!response.ok) throw failureFromResponse(operation, response.status, json)
    const parsed = def.response.safeParse(json)
    if (!parsed.success) {
      throw new ConnectorCallError(`Connector ${operation}: unexpected response shape`, {
        code: CONNECTOR_PROTOCOL_ERROR_CODE,
        retryable: false,
        detail: issueSummary(parsed.error),
        status: response.status,
      })
    }
    return parsed.data as z.infer<D['response']>
  } catch (error) {
    if (error instanceof ConnectorCallError) throw error
    throw new ConnectorCallError(`Connector ${operation}: could not reach the service`, {
      code: CONNECTOR_UNREACHABLE_CODE,
      retryable: true,
      cause: error,
    })
  } finally {
    clearTimeout(timeout)
  }
}
