import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { decryptOAuthFlowValue, encryptOAuthFlowValue } from './oauth-flow-crypto'

/**
 * Server-side state for a browser-driven OAuth flow that must finish on the
 * origin it started from, for the user who started it (table oauth_flows,
 * migration 20260907120000).
 *
 * The `state` handed to the provider is the row id: a random token that
 * encodes nothing. The row records who started the flow (user + company),
 * where (the validated app or brand origin), and what the token exchange
 * must repeat (redirect URI, PKCE verifier, connector state).
 *
 * Hosted, the provider redirects to a registered callback host that carries
 * no app session cookies. The callback there consumes the state (hop 1),
 * stashes the provider's code or error encrypted on the row under a separate
 * handoff id, and redirects to the recorded origin. The callback on that
 * origin consumes the handoff (hop 2), has the initiator's cookies, and can
 * bind the completion to the initiating user before exchanging the code.
 *
 * Every consume is a single UPDATE or DELETE whose WHERE clause is the whole
 * check: a replayed or concurrent callback loses the row-lock race and gets
 * null, with no read-then-write window. Every failure mode (unknown, forged,
 * expired, consumed, wrong origin, unreadable ciphertext) is the same null:
 * the callbacks are unauthenticated and must not be an oracle.
 */

export type OAuthFlowKind = 'skatteverket'

export interface OAuthFlow {
  id: string
  kind: OAuthFlowKind
  companyId: string
  userId: string
  origin: string
  redirectUri: string
  codeVerifier: string | null
  connectorState: string | null
  returnTo: string | null
}

export interface OAuthFlowHandoff extends OAuthFlow {
  providerCode: string | null
  providerError: string | null
}

/** How long an authorize URL stays completable. */
export const OAUTH_FLOW_TTL_SECONDS = 10 * 60
/**
 * How long hop 1's stash stays claimable by hop 2. Long enough for the
 * initiator to sign in again when hop 2 finds no session (the login page
 * forwards straight back into the callback); the provider code inside it
 * expires on the provider's side anyway.
 */
export const OAUTH_FLOW_HANDOFF_TTL_SECONDS = 5 * 60

// Column set every consume returns; decrypted into an OAuthFlow below.
const FLOW_COLUMNS =
  'id, kind, company_id, user_id, origin, redirect_uri, code_verifier, connector_state, return_to'

type FlowRow = {
  id: string
  kind: string
  company_id: string
  user_id: string
  origin: string
  redirect_uri: string
  code_verifier: string | null
  connector_state: string | null
  return_to: string | null
}

export function newOAuthFlowId(): string {
  return randomBytes(32).toString('base64url')
}

function verifierContext(row: { id: string; user_id: string; origin: string }): string {
  return JSON.stringify([row.id, row.user_id, row.origin, 'code_verifier'])
}

function handoffContext(
  row: { id: string; user_id: string; origin: string },
  handoffId: string,
  column: 'handoff_code' | 'handoff_error',
): string {
  return JSON.stringify([row.id, handoffId, row.user_id, row.origin, column])
}

function rowToFlow(row: FlowRow): OAuthFlow {
  return {
    id: row.id,
    kind: row.kind as OAuthFlowKind,
    companyId: row.company_id,
    userId: row.user_id,
    origin: row.origin,
    redirectUri: row.redirect_uri,
    codeVerifier: row.code_verifier === null ? null : decryptOAuthFlowValue(row.code_verifier, verifierContext(row)),
    connectorState: row.connector_state,
    returnTo: row.return_to,
  }
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.$/, '').replace(/\.(?=:\d+$)/, '')
}

/**
 * The host the browser addressed, from the Host header (what the browser
 * typed) rather than the URL Next.js reconstructed. Only the host: the
 * scheme of request.url comes from x-forwarded-proto, which a self-hoster's
 * reverse proxy may not send, and must never decide whether two hops are on
 * the same origin. Anything that is not a bare host falls back to the URL.
 */
export function requestHost(request: Request): string {
  const url = new URL(request.url)
  const host = request.headers.get('host') ?? url.host
  try {
    const candidate = new URL(`https://${host}`)
    if (
      candidate.host !== host.toLowerCase() ||
      candidate.pathname !== '/' ||
      candidate.search ||
      candidate.hash
    ) {
      return normalizeHost(url.host)
    }
    return normalizeHost(candidate.host)
  } catch {
    return normalizeHost(url.host)
  }
}

/** Whether the request was addressed to the host of `origin`. */
export function requestMatchesOrigin(request: Request, origin: string): boolean {
  return requestHost(request) === normalizeHost(new URL(origin).host)
}

/**
 * The origin a flow started on (or, on hop 2, arrived on), validated: the
 * canonical app origin, or an HTTPS brand domain that resolves in the brands
 * table. Decided by host alone with the scheme taken from configuration, so
 * a proxy that forwards Host without x-forwarded-proto still resolves to the
 * same origin on every hop. Anything else (an unknown host, a non-default
 * port) is treated as the app origin, so a forged Host header can never make
 * the callback hand a code to a stranger.
 */
export async function resolveOAuthOrigin(request: Request): Promise<string> {
  const appOrigin = new URL(process.env.NEXT_PUBLIC_APP_URL || request.url).origin
  const host = requestHost(request)
  if (host === normalizeHost(new URL(appOrigin).host)) return appOrigin
  if (host.includes(':')) return appOrigin
  const brand = await resolveBrandByHost(host)
  return brand && normalizeHost(new URL(`https://${brand.domain}`).host) === host
    ? `https://${host}`
    : appOrigin
}

export interface CreateOAuthFlowInput {
  id: string
  kind: OAuthFlowKind
  companyId: string
  userId: string
  origin: string
  redirectUri: string
  codeVerifier?: string | null
  connectorState?: string | null
  returnTo?: string | null
  ttlSeconds?: number
}

/** Insert the flow row. `id` is the state the caller sends to the provider. */
export async function createOAuthFlow(db: SupabaseClient, input: CreateOAuthFlowInput): Promise<void> {
  const ttl = input.ttlSeconds ?? OAUTH_FLOW_TTL_SECONDS
  const identity = { id: input.id, user_id: input.userId, origin: input.origin }
  const { error } = await db.from('oauth_flows').insert({
    id: input.id,
    kind: input.kind,
    company_id: input.companyId,
    user_id: input.userId,
    origin: input.origin,
    redirect_uri: input.redirectUri,
    code_verifier:
      input.codeVerifier == null ? null : encryptOAuthFlowValue(input.codeVerifier, verifierContext(identity)),
    connector_state: input.connectorState ?? null,
    return_to: input.returnTo ?? null,
    expires_at: new Date(Date.now() + ttl * 1000).toISOString(),
  })
  if (error) throw new Error(`Failed to create OAuth flow: ${error.message}`)
}

/** Who a flow belongs to and where it must finish, without consuming it. */
export interface OAuthFlowIdentity {
  userId: string
  origin: string
}

/**
 * Read a live state's identity without consuming it, so the callback can
 * bind the completing browser to the initiator BEFORE the one-shot state is
 * spent: a session-less arrival is sent to login and resumes, a wrong user
 * is refused, and the true initiator can still finish. Never trusted for
 * anything but that identity check; the consume below is the gate.
 */
export async function peekOAuthFlowState(
  db: SupabaseClient,
  state: string,
  kind: OAuthFlowKind,
): Promise<OAuthFlowIdentity | null> {
  const { data, error } = await db
    .from('oauth_flows')
    .select('user_id, origin')
    .eq('id', state)
    .eq('kind', kind)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return { userId: data.user_id as string, origin: data.origin as string }
}

/** Same as peekOAuthFlowState, for a live handoff bound to `origin`. */
export async function peekOAuthFlowHandoff(
  db: SupabaseClient,
  handoffId: string,
  origin: string,
  kind: OAuthFlowKind,
): Promise<OAuthFlowIdentity | null> {
  const { data, error } = await db
    .from('oauth_flows')
    .select('user_id, origin')
    .eq('handoff_id', handoffId)
    .eq('origin', origin)
    .eq('kind', kind)
    .gt('handoff_expires_at', new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return { userId: data.user_id as string, origin: data.origin as string }
}

/**
 * Consume the state once. The UPDATE's WHERE clause is the entire check:
 * unconsumed, unexpired, of the expected kind. Null for every failure.
 */
export async function consumeOAuthFlowState(
  db: SupabaseClient,
  state: string,
  kind: OAuthFlowKind,
): Promise<OAuthFlow | null> {
  const now = new Date().toISOString()
  const { data, error } = await db
    .from('oauth_flows')
    .update({ used_at: now })
    .eq('id', state)
    .eq('kind', kind)
    .is('used_at', null)
    .gt('expires_at', now)
    .select(FLOW_COLUMNS)
    .maybeSingle()
  if (error || !data) return null
  try {
    return rowToFlow(data as FlowRow)
  } catch {
    return null
  }
}

/**
 * Hop 1: stash the provider's result on the consumed row under a fresh
 * handoff id, encrypted and bound to the row, the handoff id and the
 * destination origin. Returns the handoff id to put in the hop-2 URL.
 */
export async function mintOAuthFlowHandoff(
  db: SupabaseClient,
  flow: OAuthFlow,
  result: { providerCode: string; providerError?: never } | { providerCode?: never; providerError: string },
): Promise<string> {
  const handoffId = newOAuthFlowId()
  const identity = { id: flow.id, user_id: flow.userId, origin: flow.origin }
  const { data, error } = await db
    .from('oauth_flows')
    .update({
      handoff_id: handoffId,
      handoff_code:
        result.providerCode === undefined
          ? null
          : encryptOAuthFlowValue(result.providerCode, handoffContext(identity, handoffId, 'handoff_code')),
      handoff_error:
        result.providerError === undefined
          ? null
          : encryptOAuthFlowValue(result.providerError, handoffContext(identity, handoffId, 'handoff_error')),
      handoff_expires_at: new Date(Date.now() + OAUTH_FLOW_HANDOFF_TTL_SECONDS * 1000).toISOString(),
    })
    .eq('id', flow.id)
    .is('handoff_id', null)
    .not('used_at', 'is', null)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(`Failed to mint OAuth handoff: ${error.message}`)
  if (!data) throw new Error('Failed to mint OAuth handoff: flow already handed off')
  return handoffId
}

/**
 * Hop 2: claim the handoff once, only from the origin it was minted for.
 * DELETE RETURNING, so the held provider code leaves the database the moment
 * it is read. Null for every failure, including unreadable ciphertext.
 */
export async function consumeOAuthFlowHandoff(
  db: SupabaseClient,
  handoffId: string,
  origin: string,
  kind: OAuthFlowKind,
): Promise<OAuthFlowHandoff | null> {
  const { data, error } = await db
    .from('oauth_flows')
    .delete()
    .eq('handoff_id', handoffId)
    .eq('origin', origin)
    .eq('kind', kind)
    .gt('handoff_expires_at', new Date().toISOString())
    .select(`${FLOW_COLUMNS}, handoff_code, handoff_error`)
    .maybeSingle()
  if (error || !data) return null
  const row = data as FlowRow & { handoff_code: string | null; handoff_error: string | null }
  try {
    const identity = { id: row.id, user_id: row.user_id, origin: row.origin }
    return {
      ...rowToFlow(row),
      providerCode:
        row.handoff_code === null
          ? null
          : decryptOAuthFlowValue(row.handoff_code, handoffContext(identity, handoffId, 'handoff_code')),
      providerError:
        row.handoff_error === null
          ? null
          : decryptOAuthFlowValue(row.handoff_error, handoffContext(identity, handoffId, 'handoff_error')),
    }
  } catch {
    // The row is already gone. Tampered or unreadable credentials get the
    // same answer as an unknown or expired handoff.
    return null
  }
}

/**
 * Drop rows nothing can consume any more: an hour past state expiry, and
 * for rows that were handed off, an hour past handoff expiry too. Called
 * best-effort from /authorize; the row set is tiny and self-limiting.
 */
export async function purgeExpiredOAuthFlows(db: SupabaseClient): Promise<void> {
  const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString()
  const { error } = await db
    .from('oauth_flows')
    .delete()
    .lt('expires_at', cutoff)
    .or(`handoff_expires_at.is.null,handoff_expires_at.lt.${cutoff}`)
  if (error) throw new Error(`Failed to purge OAuth flows: ${error.message}`)
}
