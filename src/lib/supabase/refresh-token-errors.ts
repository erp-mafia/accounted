/**
 * Rejected refresh tokens, logged as the ordinary sign-out they are.
 *
 * A refresh token GoTrue no longer knows (`refresh_token_not_found`: the
 * session expired, was signed out elsewhere or revoked) or has already
 * rotated (`refresh_token_already_used`) ends the session. The proxy already
 * treats that as signed out: auth-js removes the session, the proxy clears
 * the cookies, pages bounce to /login and API routes answer 401.
 *
 * The noise comes from inside auth-js, not from our code. @supabase/ssr's
 * createServerClient subscribes to onAuthStateChange, and auth-js answers
 * every new subscriber with an INITIAL_SESSION event whose session load
 * refreshes an expired token; when that refresh is refused it hands the
 * AuthApiError to `console.error`, stack and all (GoTrueClient
 * `_emitInitialSession`). Production counted those as errors: about 300 a
 * week for 87 users, all from the proxy. There is no option to switch that
 * log off, so the one console call is narrowed here: exactly one argument,
 * an auth-js error (`__isAuthError`), with one of the two codes above. That
 * call becomes one structured line at info (not found) or warn (already
 * used: two requests refreshed the same token, worth watching) without the
 * stack. Every other console.error passes through untouched.
 */

export type RejectedRefreshTokenCode = 'refresh_token_not_found' | 'refresh_token_already_used'

const REJECTED_REFRESH_TOKEN_CODES: ReadonlySet<string> = new Set<RejectedRefreshTokenCode>([
  'refresh_token_not_found',
  'refresh_token_already_used',
])

/** The rejected-refresh-token code `value` carries, or null for anything else. */
export function rejectedRefreshTokenCode(value: unknown): RejectedRefreshTokenCode | null {
  if (!value || typeof value !== 'object') return null
  const error = value as { __isAuthError?: unknown; code?: unknown }
  if (error.__isAuthError !== true || typeof error.code !== 'string') return null
  return REJECTED_REFRESH_TOKEN_CODES.has(error.code) ? (error.code as RejectedRefreshTokenCode) : null
}

const QUIETED = Symbol.for('accounted.quietRejectedRefreshTokens')

type ConsoleError = ((...args: unknown[]) => void) & { [QUIETED]?: true }

/**
 * Route `target.error(rejectedRefreshTokenError)` to `report` instead.
 * Idempotent: a second install on the same target is a no-op, so module
 * re-evaluation never stacks wrappers.
 */
export function quietRejectedRefreshTokenErrors(
  target: { error: (...args: unknown[]) => void },
  report: (code: RejectedRefreshTokenCode) => void,
): void {
  const current = target.error as ConsoleError
  if (current[QUIETED]) return

  const quiet: ConsoleError = (...args: unknown[]) => {
    const code = args.length === 1 ? rejectedRefreshTokenCode(args[0]) : null
    if (code) {
      report(code)
      return
    }
    current.apply(target, args)
  }
  quiet[QUIETED] = true
  target.error = quiet
}
