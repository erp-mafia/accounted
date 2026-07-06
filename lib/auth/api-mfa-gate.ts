/**
 * Decide whether an `/api` request should SKIP the middleware MFA (AAL2) gate.
 *
 * Most `/api` routes historically hand-roll `supabase.auth.getUser()` instead
 * of `requireAuth()`, which means they never enforce MFA. The middleware gate
 * (lib/supabase/middleware.ts) closes that gap for cookie sessions, but a few
 * request classes must NOT be gated:
 *
 *   - Bearer-authenticated SURFACES (`/api/v1/*` API keys, the MCP endpoint's
 *     OAuth tokens/API keys): the route validates the Authorization credential
 *     itself and never trusts the cookie session, so a logged-in AAL1 browser
 *     testing its own API key must not be blocked. This is scoped by PATH, not
 *     header presence: the header is attacker-controlled, and an Authorization
 *     header riding on a cookie-authenticated route must never disable the
 *     gate (the route would ignore the header and authenticate via cookies,
 *     i.e. a stolen-password session could bypass MFA with `Authorization: x`).
 *     Pure Bearer callers elsewhere (cron secret, signed webhooks) carry no
 *     cookie session, so the gate: which only fires for cookie users: never
 *     touches them and they need no exemption.
 *   - The AAL1 escape hatch: a user with MFA required but not yet verified (or a
 *     BankID-only user setting a first password) must still reach
 *     `/api/account/*` and `/api/company*` to COMPLETE onboarding / enroll MFA.
 *   - The MCP OAuth endpoints (`/api/mcp-oauth/*`) carry their own PKCE +
 *     single-use-code security and drive the connector authorize flow.
 *
 * Kept as a pure function so the allowlist is unit-testable in isolation.
 */

// Routes whose auth contract IS the Authorization header. Everything else
// under /api/extensions/ext/ authenticates via requireAuth (cookies) in the
// dispatcher and must stay behind the gate.
const BEARER_AUTH_PREFIXES = ['/api/v1/', '/api/extensions/ext/mcp-server/mcp']

export function apiPathSkipsMfaGate(
  pathname: string,
  hasAuthorizationHeader: boolean,
): boolean {
  if (
    hasAuthorizationHeader &&
    BEARER_AUTH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return true
  }
  return (
    pathname.startsWith('/api/account/') ||
    pathname.startsWith('/api/company') ||
    pathname.startsWith('/api/mcp-oauth/')
  )
}
