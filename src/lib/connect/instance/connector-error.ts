/**
 * The error a failed connector call throws, and the adapter-side codes it can
 * carry. A module of its own, without the contract package: browser code that
 * only names the error (lib/collections/errors.ts and the pages that show its
 * text) would otherwise ship the whole contract and its schemas.
 * connector-fetch.ts re-exports everything here.
 */

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
  /** The provider's own code when the service relayed a provider refusal (the envelope's providerCode). */
  readonly providerCode: string | null
  /** The service's Retry-After in seconds, when it sent one (a rate limit); null otherwise. */
  readonly retryAfterSeconds: number | null

  constructor(
    message: string,
    options: {
      code: string
      retryable: boolean
      detail?: string | null
      status?: number | null
      providerCode?: string | null
      retryAfterSeconds?: number | null
      cause?: unknown
    },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ConnectorCallError'
    this.code = options.code
    this.retryable = options.retryable
    this.detail = options.detail ?? null
    this.status = options.status ?? null
    this.providerCode = options.providerCode ?? null
    this.retryAfterSeconds = options.retryAfterSeconds ?? null
  }
}
