/**
 * Thin `fetch` wrapper that aborts after a deadline.
 *
 * Used by OAuth token endpoints where a hung provider would otherwise hold
 * the request thread indefinitely. The Skatteverket callback handler also
 * relies on `TimeoutError` to distinguish a hung token exchange (where the
 * 5-minute BankID auth code may expire mid-call) from other failures.
 */

export class TimeoutError extends Error {
  readonly name = 'TimeoutError'
}

export function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

export const OAUTH_TIMEOUT_MS = 10_000
export const OAUTH_REVOKE_TIMEOUT_MS = 5_000
export const SKATTEVERKET_EXCHANGE_TIMEOUT_MS = 8_000

interface FetchWithTimeoutOptions {
  timeoutMs: number
  description: string
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  options: FetchWithTimeoutOptions,
): Promise<Response> {
  const { timeoutMs, description } = options

  const timeoutSignal = AbortSignal.timeout(timeoutMs)
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal

  try {
    return await fetch(input, { ...init, signal })
  } catch (err) {
    if (
      timeoutSignal.aborted &&
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError')
    ) {
      throw new TimeoutError(`${description} timed out after ${timeoutMs}ms`)
    }
    throw err
  }
}
