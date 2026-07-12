import type Stripe from 'stripe'
import { getStripe } from '@/lib/stripe/client'

/**
 * Stripe Connect (OAuth for Standard accounts) helpers.
 *
 * Accounted's own Stripe account is the Connect PLATFORM. A company's Stripe
 * account attaches via the OAuth flow; from then on every API call runs with
 * the platform secret key plus the `Stripe-Account` header. We never hold a
 * per-company key or token: the stored acct_... id is useless without the
 * platform key, and either side can revoke the connection at any time.
 */

const OAUTH_AUTHORIZE_URL = 'https://connect.stripe.com/oauth/authorize'

export function getConnectClientId(): string | undefined {
  return process.env.STRIPE_CONNECT_CLIENT_ID
}

/** Whether the Connect integration is configured on this deployment. */
export function isStripeConnectConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_CONNECT_CLIENT_ID)
}

/** Whether the platform key runs in live mode (payments affect real money). */
export function isLiveMode(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.startsWith('sk_live_'))
}

/** Per-request options routing an API call to the connected account. */
export function connectedAccountOptions(stripeAccountId: string): Stripe.RequestOptions {
  return { stripeAccount: stripeAccountId }
}

/** Build the connect.stripe.com authorize URL for the OAuth round-trip. */
export function buildAuthorizeUrl(state: string): string {
  const clientId = getConnectClientId()
  if (!clientId) throw new Error('STRIPE_CONNECT_CLIENT_ID is not configured')
  const redirectUri = `${process.env.NEXT_PUBLIC_APP_URL}/api/extensions/stripe/callback`
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: 'read_write',
    state,
    redirect_uri: redirectUri,
  })
  return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`
}

export interface ConnectedAccount {
  stripeAccountId: string
  livemode: boolean
}

/** Exchange the OAuth authorization code for the connected account id. */
export async function exchangeCodeForAccount(code: string): Promise<ConnectedAccount> {
  const token = await getStripe().oauth.token({ grant_type: 'authorization_code', code })
  if (!token.stripe_user_id) {
    throw new Error('Stripe OAuth token response missing stripe_user_id')
  }
  return {
    stripeAccountId: token.stripe_user_id,
    livemode: token.livemode ?? isLiveMode(),
  }
}

/**
 * Revoke the platform's access to a connected account. Idempotent from our
 * side: an already-deauthorized account throws, which callers treat as done.
 */
export async function deauthorizeAccount(stripeAccountId: string): Promise<void> {
  const clientId = getConnectClientId()
  if (!clientId) throw new Error('STRIPE_CONNECT_CLIENT_ID is not configured')
  await getStripe().oauth.deauthorize({ client_id: clientId, stripe_user_id: stripeAccountId })
}

/** Best-effort display name for the settings panel; never throws. */
export async function fetchAccountDisplayName(stripeAccountId: string): Promise<string | null> {
  try {
    const account = await getStripe().accounts.retrieve(stripeAccountId)
    return (
      account.business_profile?.name ||
      account.settings?.dashboard?.display_name ||
      account.email ||
      null
    )
  } catch {
    return null
  }
}

/**
 * Whether an API error means the connection itself is dead (the account
 * deauthorized the platform, or the account no longer exists), as opposed to
 * a transient failure. Used to flip a connection to status 'revoked' so the
 * UI offers a reconnect instead of retrying forever.
 */
export function isRevokedConnectionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const err = error as { type?: string; code?: string; message?: string }
  if (err.type === 'StripePermissionError') return true
  if (err.code === 'account_invalid') return true
  // The OAuth layer reports a severed connection with this phrasing.
  return /not connected to your platform|application access may have been revoked/i.test(
    err.message ?? '',
  )
}
