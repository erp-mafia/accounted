/**
 * Why a document reading came back with nothing, as far as anything after it
 * needs to know: the AI provider could not take the call
 * (`provider_unavailable`), or anything else (`error`).
 *
 * Only the first is worth reading again by itself. A provider outage says
 * nothing about the document: on 2026-10-26 Bedrock answered 08:35-11:29 UTC
 * with `503 Bedrock is unable to process your request.`, and every upload in
 * that window looked exactly like an unreadable document. A parse or schema
 * failure, a refused document (400), expired credentials or a missing model
 * fail the same way on every attempt; those stay visible as before and are
 * never retried into silence.
 */
export type ExtractionFailure = 'provider_unavailable' | 'error'

// 408 request timeout, 429 throttling, every 5xx (529 is Anthropic's
// overloaded_error, 503 Bedrock's "unable to process your request").
function isUnavailableStatus(status: number): boolean {
  return status === 408 || status === 429 || (status >= 500 && status <= 599)
}

// The error `type` in an Anthropic error body ({ error: { type } }).
const UNAVAILABLE_ERROR_TYPES = new Set(['overloaded_error', 'api_error', 'rate_limit_error', 'timeout_error'])

// Class names, for errors that carry no status: the Anthropic SDK's
// connection errors, the AWS-shaped Bedrock exceptions, and a call our own
// time limit ended (lib/ai/call-limit.ts): a call that gave no answer in time
// says nothing about the document.
const UNAVAILABLE_ERROR_NAMES = new Set([
  'AiCallTimeoutError',
  'APIConnectionError',
  'APIConnectionTimeoutError',
  'RateLimitError',
  'InternalServerError',
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelNotReadyException',
  'ModelTimeoutException',
])

// Socket and DNS failures from Node and undici, usually on a fetch error's cause.
const NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'ETIMEDOUT',
  'EPIPE',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'UND_ERR_SOCKET',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

const UNAVAILABLE_MESSAGE =
  /unable to process your request|overloaded|too many requests|throttl|service unavailable|temporarily unavailable|rate limit|fetch failed|socket hang up|connection error|request timed out/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function statusOf(err: Record<string, unknown>): number | null {
  // Anthropic SDK: status. AI SDK (OpenAI-compatible): statusCode. AWS SDK: $metadata.httpStatusCode.
  for (const value of [err.status, err.statusCode, isRecord(err.$metadata) ? err.$metadata.httpStatusCode : undefined]) {
    if (typeof value === 'number' && Number.isFinite(value)) return value
  }
  return null
}

function errorTypeOf(err: Record<string, unknown>): string | null {
  const body = err.error
  if (!isRecord(body)) return null
  if (isRecord(body.error) && typeof body.error.type === 'string') return body.error.type
  return typeof body.type === 'string' ? body.type : null
}

function looksUnavailable(err: unknown, depth: number): boolean {
  if (depth > 4 || !isRecord(err)) return false
  // A status is decisive: a 400 whose text happens to say "unable to process"
  // is a document the provider refused, not an outage.
  const status = statusOf(err)
  if (status != null) return isUnavailableStatus(status)
  const type = errorTypeOf(err)
  if (type && UNAVAILABLE_ERROR_TYPES.has(type)) return true
  if (typeof err.code === 'string' && NETWORK_ERROR_CODES.has(err.code)) return true
  const ctorName = typeof err.constructor === 'function' ? err.constructor.name : null
  if ((typeof err.name === 'string' && UNAVAILABLE_ERROR_NAMES.has(err.name)) || (ctorName && UNAVAILABLE_ERROR_NAMES.has(ctorName))) {
    return true
  }
  if (typeof err.message === 'string' && UNAVAILABLE_MESSAGE.test(err.message)) return true
  // The AI SDK wraps its own retries in a RetryError whose lastError is the call's.
  if ('lastError' in err && looksUnavailable(err.lastError, depth + 1)) return true
  return looksUnavailable(err.cause, depth + 1)
}

/**
 * Classify a thrown extraction call. `deadlineReached` is true when the
 * reading's own deadline (EXTRACTION_DEADLINE_MS) aborted it: that counts as
 * the provider being unavailable, see extractInvoiceFields.
 */
export function classifyExtractionError(
  err: unknown,
  opts: { deadlineReached?: boolean } = {},
): ExtractionFailure {
  if (opts.deadlineReached) return 'provider_unavailable'
  return looksUnavailable(err, 0) ? 'provider_unavailable' : 'error'
}
