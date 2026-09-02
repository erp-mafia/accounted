/**
 * Small, shared readers for the `{ error }` envelope the report API routes
 * return. Deliberately NOT lib/errors getErrorMessage: that one rewrites known
 * patterns into user-facing Swedish, these just pick the string out.
 */

/** A string error is itself; an object with a string `message` yields it; else the fallback. */
export function parseApiError(error: unknown, fallback: string): string {
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return fallback
}

/** parseApiError applied to a JSON body's `error` field. */
export function apiErrorMessage(json: unknown, fallback: string): string {
  return parseApiError((json as { error?: unknown } | null)?.error, fallback)
}
