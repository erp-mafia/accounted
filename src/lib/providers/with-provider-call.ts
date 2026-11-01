/**
 * Code-mapped errors for calls to third-party providers (Fortnox, Bokio,
 * Visma, Briox, BL/Björn Lundén, Enable Banking, etc.).
 *
 * classifyProviderError translates HTTP failures and network errors into a
 * ProviderCallError code, which the route wrapper's errorResponse()
 * recognises as a structured code. This keeps the user message + remediation
 * consistent across providers without each call site having to repeat the
 * mapping.
 */

// Fortnox is the one provider with a typed reading of "this account may not
// read this resource" (fortnoxRefusal: documented codes, a 403, or a 400 with
// a permission body). Every Fortnox door classifies through it, so the
// migration job, the SIE preview and the underlag import cannot disagree.
import { fortnoxRefusal } from './fortnox/client'
import { FortnoxOAuthError } from './fortnox/oauth-error'
import { isBokioPricePlanError } from './bokio/client'

export type ProviderCallErrorCode =
  | 'PROVIDER_AUTH_EXPIRED'
  | 'PROVIDER_RESOURCE_FORBIDDEN'
  | 'PROVIDER_LICENSE_MISSING'
  | 'PROVIDER_API_MODULE_INACTIVE'
  | 'BOKIO_PLAN_NO_API'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_UNREACHABLE'
  | 'PROVIDER_UPSTREAM_ERROR'
  | 'PROVIDER_CONFIGURATION_ERROR'

export class ProviderCallError extends Error {
  readonly code: ProviderCallErrorCode
  readonly provider: string
  readonly status?: number
  readonly retryAfterSeconds?: number
  readonly providerCode?: string
  readonly credentialRevision?: string

  constructor(
    code: ProviderCallErrorCode,
    provider: string,
    message: string,
    extras: { status?: number; retryAfterSeconds?: number; providerCode?: string; credentialRevision?: string } = {},
  ) {
    super(message)
    this.name = 'ProviderCallError'
    this.code = code
    this.provider = provider
    this.status = extras.status
    this.retryAfterSeconds = extras.retryAfterSeconds
    this.providerCode = extras.providerCode
    this.credentialRevision = extras.credentialRevision
  }
}

function isNetworkError(err: Error): boolean {
  // node-undici throws TypeError('fetch failed') with a `cause` for DNS/TCP issues.
  if (err.name === 'TypeError' && /fetch failed/i.test(err.message)) return true
  if (err.name === 'AbortError') return true
  // Known undici error codes
  const cause = (err as Error & { cause?: { code?: string } }).cause
  if (cause?.code && ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'].includes(cause.code)) {
    return true
  }
  return false
}

export interface ClassifyProviderErrorOptions {
  /**
   * True when an earlier provider call in the same run already returned data.
   * The access token is then provably alive, so a 403 after that point is the
   * provider closing ONE resource, not the grant dying. Leave it false (the
   * default) when the failing call is the first one: an opaque 403 there is
   * indistinguishable from a revoked grant and must keep saying "reconnect".
   *
   * Data returned, not a promise that resolved: several fetchers answer with
   * an empty list before issuing any request (a provider company id we do not
   * have, a register the provider does not expose), and those prove nothing.
   */
  grantProven?: boolean
}

/**
 * Classify an error from a provider client (Fortnox/Bokio/Visma/Briox/BL) into
 * a structured error code. Reads `statusCode` (Fortnox client) or `status`
 * (other clients) off the thrown error and maps:
 *
 *   401     → PROVIDER_AUTH_EXPIRED
 *   Fortnox refusal (fortnoxRefusal: a documented code, a 403, or a 400
 *           naming a missing right or licence) → PROVIDER_RESOURCE_FORBIDDEN,
 *           or PROVIDER_LICENSE_MISSING when the whole account lacks the API
 *           licence (2001103)
 *   Bokio 403 price_plan_feature_required → BOKIO_PLAN_NO_API: the plan has no
 *           API access, and the token may be fine
 *   403     → PROVIDER_RESOURCE_FORBIDDEN when `options.grantProven` says an
 *             earlier call in the same run already succeeded on this token;
 *             otherwise PROVIDER_AUTH_EXPIRED
 *   429     → PROVIDER_RATE_LIMITED
 *   5xx     → PROVIDER_UPSTREAM_ERROR
 *   network → PROVIDER_UNREACHABLE
 *   other   → null (caller falls back to its domain-specific code, e.g.
 *             `PROVIDER_SIE_FETCH_FAILED`)
 *
 * Use at the boundary where a provider call's failure becomes a user-facing
 * response. Lets the toast show a specific Swedish message ("Anslutningen har
 * gått ut. Återanslut för att fortsätta." vs. "Försök igen om en stund.")
 * instead of the same generic message for every cause.
 */
export function classifyProviderError(
  error: unknown,
  options: ClassifyProviderErrorOptions = {},
): ProviderCallErrorCode | null {
  if (error instanceof FortnoxOAuthError) {
    if (error.status === 429) return 'PROVIDER_RATE_LIMITED'
    if (error.status >= 500) return 'PROVIDER_UPSTREAM_ERROR'
    if (['invalid_client', 'unauthorized_client', 'invalid_request', 'unsupported_grant_type', 'invalid_scope'].includes(error.providerCode ?? '')) return 'PROVIDER_CONFIGURATION_ERROR'
    if (['error_missing_license', 'error_missing_app_license'].includes(error.providerCode ?? '')) return 'PROVIDER_LICENSE_MISSING'
    if (error.operation === 'refresh' && error.providerCode === 'invalid_grant') return 'PROVIDER_AUTH_EXPIRED'
    return 'PROVIDER_UPSTREAM_ERROR'
  }
  const refusal = fortnoxRefusal(error)
  if (refusal) return refusal.reason === 'api_license' ? 'PROVIDER_LICENSE_MISSING' : 'PROVIDER_RESOURCE_FORBIDDEN'
  if (isBokioPricePlanError(error)) return 'BOKIO_PLAN_NO_API'
  if (error instanceof ProviderCallError) {
    // An error labelled from one response cannot know the run's history, so
    // a 403 already labelled AUTH_EXPIRED is re-read here with it.
    if (error.code === 'PROVIDER_AUTH_EXPIRED' && error.status === 403 && options.grantProven) {
      return 'PROVIDER_RESOURCE_FORBIDDEN'
    }
    return error.code
  }
  if (!(error instanceof Error)) return null

  const status =
    (error as Error & { statusCode?: number; status?: number }).statusCode ??
    (error as Error & { statusCode?: number; status?: number }).status

  // Provider clients (e.g. VismaApiError) carry the response body separately
  // from the Error message; both can hold the discriminating string.
  const body = (error as Error & { body?: unknown }).body
  const haystack = typeof body === 'string' ? `${error.message} ${body}` : error.message

  // Order matters: 401/403 with a module/license body is a subscription
  // problem, not a dead token. Mapping it to AUTH_EXPIRED would send the user
  // into a reconnect loop that can never succeed (the exact failure mode this
  // classification exists to prevent).
  if (isApiModuleInactiveError(haystack)) return 'PROVIDER_API_MODULE_INACTIVE'
  if (isMissingLicenseError(haystack)) return 'PROVIDER_LICENSE_MISSING'

  if (typeof status === 'number') {
    // A 403 is only a dead grant when nothing else says otherwise: a provider
    // that reserves 403 for the resource and answers 401 for a dead token
    // (Fortnox, read above by fortnoxRefusal), or the same token having
    // already answered earlier in this run, both mean the grant is alive and
    // one register is closed. 401 is never downgraded: that IS a dead token.
    if (status === 403 && options.grantProven) {
      return 'PROVIDER_RESOURCE_FORBIDDEN'
    }
    if (status === 401 || status === 403) return 'PROVIDER_AUTH_EXPIRED'
    if (status === 429) return 'PROVIDER_RATE_LIMITED'
    if (status >= 500) return 'PROVIDER_UPSTREAM_ERROR'
  }
  if (isNetworkError(error)) return 'PROVIDER_UNREACHABLE'

  return null
}

/**
 * The codes that answer the same until someone acts at the provider or on the
 * connection: a dead token, a closed register, a missing licence or module.
 */
const REFUSAL_CODES: ReadonlySet<ProviderCallErrorCode> = new Set<ProviderCallErrorCode>([
  'PROVIDER_AUTH_EXPIRED',
  'PROVIDER_RESOURCE_FORBIDDEN',
  'PROVIDER_LICENSE_MISSING',
  'PROVIDER_API_MODULE_INACTIVE',
  'BOKIO_PLAN_NO_API',
])

/**
 * Did the provider refuse, as opposed to fail? The one yes-or-no reading of
 * classifyProviderError, for a door that stops on a refusal and needs no more
 * than that: the next call gets the same answer, whatever the status it came
 * under (Fortnox refuses a register with a 403 or a 400).
 */
export function isProviderRefusal(error: unknown): boolean {
  const code = classifyProviderError(error)
  return code !== null && REFUSAL_CODES.has(code)
}

/** Why the provider refused one register. */
export type ProviderRefusalReason = 'license' | 'permission'

/**
 * Why the provider refused a register that classifyProviderError reads as
 * PROVIDER_RESOURCE_FORBIDDEN. The two causes have different remedies, and
 * Fortnox tells them apart (fortnoxRefusal):
 *
 *   license     2001101 "Det finns ingen aktiv licens för önskat scope": the
 *               Fortnox company's plan lacks the module the register needs
 *               (customers and invoices need Kundfaktura or Order). No
 *               reconnect can change that; activating the module can.
 *   permission  everything else: 2000663 "Har inte behörighet för scope", or
 *               a register the user who connected may not see ("Saknar
 *               behörighet för leverantörsregister.", 403 or 400). Granting
 *               the right, or connecting as a user who has it, does.
 *
 * Other providers do not say, and read as permission.
 */
export function providerRefusalReason(error: unknown): ProviderRefusalReason {
  const reason = fortnoxRefusal(error)?.reason
  return reason === 'license' || reason === 'api_license' ? 'license' : 'permission'
}

/**
 * True when a provider token/OAuth failure means the integration license is
 * missing or inactive, NOT an ordinary expired/revoked grant.
 *
 * Fortnox answers its token endpoint with `error_missing_license` when the
 * customer's Fortnox account no longer carries the integration license. The
 * stored refresh token cannot be revived by re-authorizing: re-auth loops until
 * the customer re-orders the "Fortnox Integration" add-on. Distinguishing this
 * from a plain dead token lets callers say "activate the license, then
 * reconnect" instead of a bare "reconnect" that just fails again.
 *
 * Matches on the raw provider message string because the underlying refresh
 * helpers bake the body into the Error message; deliberately does NOT match
 * `invalid_grant` (that IS a revivable reconnect → PROVIDER_AUTH_EXPIRED).
 */
export function isMissingLicenseError(message: string): boolean {
  const haystack = message.toLowerCase()
  return (
    haystack.includes('error_missing_license') ||
    haystack.includes('missing_license') ||
    haystack.includes('missing license') ||
    haystack.includes('not have enough licenses')
  )
}

/**
 * True when a provider 403 means the customer's subscription has API access
 * switched off or not included, NOT an expired/revoked grant.
 *
 * Visma eAccounting (Spiris) answers every data endpoint with
 * `ForbiddenRequestException - No access to module: api_standard`
 * (ErrorCode 4002) when the company's plan lacks the API module or it is not
 * activated under "Appar och tillägg". OAuth still succeeds (the identity
 * server is shared), so the stored tokens are valid; re-authorizing loops
 * forever. The fix is on the customer's side: activate the API module (an
 * add-on on smaller plans) and clear any "standardföretag" selection.
 *
 * Matches the raw provider body/message string, same approach as
 * isMissingLicenseError above.
 */
export function isApiModuleInactiveError(message: string): boolean {
  return /no access to module/i.test(message)
}
