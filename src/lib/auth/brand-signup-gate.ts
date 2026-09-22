import 'server-only'

/**
 * Invite-only signup gate for white-label brand domains (founder decision
 * 2026-08-27): a brand domain belongs to the partner's people, so when a
 * brand has signup_mode = 'invite_only', creating an account on that domain
 * requires either a brand_signup_allowlist entry for the email or a valid
 * pending company invite for it. Everyone else is sent to the canonical
 * signup by the register page's interstitial.
 *
 * Enforced SERVER-SIDE at the moment an account would be created, on every
 * signup path:
 *   - email+password: POST /api/auth/signup (the register page no longer
 *     calls supabase.auth.signUp from the browser on any host, because a
 *     client-side check would be bypassable)
 *   - BankID:         extensions/general/tic /bankid/complete (signup mode)
 *   - Google OAuth:   the account exists after the OAuth round-trip, so the
 *     dashboard layout's domain gate bounces non-belonging sessions to the
 *     canonical domain instead
 *
 * Uses the cookieless service client: the visitor is anonymous at signup
 * time, so RLS cannot scope these reads. Fail-CLOSED on the allowlist and
 * invite lookups: on a transient query error a gated brand refuses the
 * signup rather than silently opening the door.
 */

import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { INVITE_COOKIE_NAME } from '@/lib/auth/consume-invite-cookie'
import { hashInviteToken } from '@/lib/auth/invite-tokens'
import {
  normalizeHost,
  resolveBrandByHost,
  resolveBrandResultByHost,
  type Brand,
} from '@/lib/branding/resolve'
import { createLogger } from '@/lib/logger'

const log = createLogger('brand-signup-gate')

export type BrandSignupGateResult =
  | {
      allowed: true
      brand: Brand | null
      /** What let the signup through, for logging and tests. */
      via: 'no_brand' | 'open' | 'allowlist' | 'invite'
    }
  | { allowed: false; brand: Brand }
  // The brands lookup itself failed (transient DB error). The caller must
  // fail SAFE (retry / 503), never treat this as an unbranded host, or a
  // blip would open invite-only signup.
  | { allowed: false; brand: null; lookupFailed: true }

/**
 * Whether `email` is on the brand's signup allowlist. Case-insensitive: the
 * table stores lowercase (CHECK-enforced) and the lookup lowercases too.
 * Fail-closed: a query error reads as "not allowlisted".
 */
export async function isEmailOnBrandAllowlist(
  brandId: string,
  email: string,
): Promise<boolean> {
  const normalized = email.trim().toLowerCase()
  if (!normalized) return false

  const supabase = createServiceClientNoCookies()
  const { data, error } = await supabase
    .from('brand_signup_allowlist')
    .select('id')
    .eq('brand_id', brandId)
    .eq('email', normalized)
    .limit(1)
    .maybeSingle()

  if (error) {
    log.error('allowlist lookup failed; treating as not allowlisted', {
      brandId,
      message: error.message,
    })
    return false
  }
  return data !== null
}

/**
 * Whether `inviteToken` is a live company invite for `email`: pending,
 * unexpired, and addressed to the same email (case-insensitive). The invite
 * itself is the authorization, so it bypasses the allowlist. Mirrors the
 * acceptance checks in /api/team/accept and /auth/callback; acceptance
 * re-validates everything, so this gate can stay a read.
 */
async function isValidInviteForEmail(
  inviteToken: string,
  email: string,
): Promise<boolean> {
  const supabase = createServiceClientNoCookies()
  const { data, error } = await supabase
    .from('company_invitations')
    .select('email, status, expires_at')
    .eq('token_hash', hashInviteToken(inviteToken))
    .maybeSingle()

  if (error) {
    log.error('invite lookup failed; treating as invalid', { message: error.message })
    return false
  }
  if (!data) return false
  return (
    data.status === 'pending' &&
    new Date(data.expires_at) > new Date() &&
    data.email.toLowerCase() === email.trim().toLowerCase()
  )
}

/**
 * Decide whether a signup with `email` may proceed on `host`.
 *
 * Allowed when the host has no brand (canonical and unknown hosts, the
 * additive guarantee), the brand is open, the email is allowlisted, or a
 * valid invite token rides along (the gnubok-invite-token cookie set by
 * /invite/[token]).
 */
export async function evaluateBrandSignupGate(opts: {
  host: string | null | undefined
  email: string
  inviteToken?: string | null
}): Promise<BrandSignupGateResult> {
  const { brand, lookupFailed } = opts.host
    ? await resolveBrandResultByHost(opts.host)
    : { brand: null, lookupFailed: false }
  if (lookupFailed) {
    // Do not fall through to no_brand: a transient brands-table error must
    // not open an invite-only domain. The caller turns this into a 503.
    log.error('brand lookup failed; refusing to decide signup gate')
    return { allowed: false, brand: null, lookupFailed: true }
  }
  if (!brand) return { allowed: true, brand: null, via: 'no_brand' }
  if (brand.signupMode !== 'invite_only') return { allowed: true, brand, via: 'open' }

  if (await isEmailOnBrandAllowlist(brand.id, opts.email)) {
    return { allowed: true, brand, via: 'allowlist' }
  }

  if (opts.inviteToken && (await isValidInviteForEmail(opts.inviteToken, opts.email))) {
    return { allowed: true, brand, via: 'invite' }
  }

  // Observability, not enumeration: log the brand and outcome, never the
  // attempted address.
  log.info('signup blocked on invite-only brand domain', { brandId: brand.id, domain: brand.domain })
  return { allowed: false, brand }
}

/**
 * Logged-in counterpart of the signup gate, for the dashboard layout: on an
 * invite-only brand host, a session that does not belong to the brand (no
 * team membership on the brand's team, no company on it, not allowlisted,
 * no pending invite) is bounced to the canonical domain instead of getting
 * a branded shell. Returns the absolute URL to redirect to, or null to stay.
 *
 * A NAVIGATION rule like the home-domain rule (WL-01), not a security
 * boundary: data access is governed by membership and RLS regardless of
 * host. That is why the pending-invite check is presence-only here; the
 * actual invite acceptance re-validates the token server-side.
 */
export async function resolveBrandDomainBounce(opts: {
  host: string
  userEmail: string | null | undefined
  /** teams.id of every team the user belongs to (any role). */
  teamIds: string[]
  /** companies.team_id of every company the user belongs to. */
  companyTeamIds: Array<string | null | undefined>
  hasPendingInviteCookie: boolean
  /** getBranding().appUrl: where non-belonging sessions are sent. */
  canonicalAppUrl: string
}): Promise<string | null> {
  const brand = opts.host ? await resolveBrandByHost(opts.host) : null
  if (!brand || brand.signupMode !== 'invite_only') return null

  if (opts.teamIds.includes(brand.teamId)) return null
  if (opts.companyTeamIds.some((teamId) => teamId === brand.teamId)) return null
  if (opts.hasPendingInviteCookie) return null

  if (opts.userEmail && (await isEmailOnBrandAllowlist(brand.id, opts.userEmail))) {
    return null
  }

  // Never bounce onto the same host (misconfigured canonical URL would
  // otherwise loop), and never bounce when no canonical URL is known.
  let canonicalHost: string
  try {
    canonicalHost = new URL(opts.canonicalAppUrl).hostname
  } catch {
    return null
  }
  if (!canonicalHost || canonicalHost === normalizeHost(opts.host)) return null

  log.info('bouncing non-member session off invite-only brand domain', {
    brandId: brand.id,
    domain: brand.domain,
  })
  return opts.canonicalAppUrl
}

/**
 * The pending-invite token from a raw Cookie header, for server routes that
 * hold a Request rather than a Next.js cookie store. The cookie is set by
 * /invite/[token] (not httpOnly, so the client auth surfaces read it too).
 */
export function readInviteTokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    if (part.slice(0, eq).trim() !== INVITE_COOKIE_NAME) continue
    const value = part.slice(eq + 1).trim()
    if (!value) return null
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  return null
}
