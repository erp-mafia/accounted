import { randomBytes } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveBrandByHost } from '@/lib/branding/resolve'
import { createLogger } from '@/lib/logger'
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
 * the callbacks are unauthenticated and must not be an oracle. Only after a
 * refusal, the inspect functions below say which check it was, for the log
 * and for recognising a second delivery of a flow that already finished.
 *
 * Claiming the handoff leaves a spent row behind (keepSpentOAuthFlow): the
 * flow's identity with no secret, which no consume can match again, so a
 * second delivery of the same provider redirect is known as this flow's
 * rather than looking unknown.
 */

const log = createLogger('auth/oauth-flows')

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
  companyId: string
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
    .select('user_id, company_id, origin')
    .eq('id', state)
    .eq('kind', kind)
    .is('used_at', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return {
    userId: data.user_id as string,
    companyId: data.company_id as string,
    origin: data.origin as string,
  }
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
    .select('user_id, company_id, origin')
    .eq('handoff_id', handoffId)
    .eq('origin', origin)
    .eq('kind', kind)
    .gt('handoff_expires_at', new Date().toISOString())
    .maybeSingle()
  if (error || !data) return null
  return {
    userId: data.user_id as string,
    companyId: data.company_id as string,
    origin: data.origin as string,
  }
}

/** A flow whose state was consumed and has not expired: who, where, and when. */
export interface UsedOAuthFlow extends OAuthFlowIdentity {
  id: string
  returnTo: string | null
  /** When /authorize created the row, epoch ms (database clock). */
  startedAt: number
  /** When hop 1 consumed the state, epoch ms. */
  usedAt: number
}

/**
 * What a state row says after a peek or consume refused it. `live` means the
 * row is unconsumed and unexpired, so the refusal was not about the state (a
 * failed read); `lookup_failed` means this read failed too.
 */
export type OAuthFlowStateInspection =
  | { status: 'used'; flow: UsedOAuthFlow }
  | { status: 'unknown' | 'expired' | 'live' | 'lookup_failed' }

/**
 * Read a state row with no liveness filter, to tell a refusal apart: never
 * there (or purged), past its expiry (used or not), consumed, or still live.
 * Never a gate: it consumes nothing, and the page answers every refusal the
 * same way. A consumed flow comes back with its identity so the callback can
 * recognise a second delivery of a flow that already finished.
 */
export async function inspectOAuthFlowState(
  db: SupabaseClient,
  state: string,
  kind: OAuthFlowKind,
): Promise<OAuthFlowStateInspection> {
  const { data, error } = await db
    .from('oauth_flows')
    .select('id, company_id, user_id, origin, return_to, created_at, expires_at, used_at')
    .eq('id', state)
    .eq('kind', kind)
    .maybeSingle()
  if (error) return { status: 'lookup_failed' }
  if (!data) return { status: 'unknown' }
  if (new Date(data.expires_at as string).getTime() <= Date.now()) return { status: 'expired' }
  if (data.used_at === null) return { status: 'live' }
  return {
    status: 'used',
    flow: {
      id: data.id as string,
      userId: data.user_id as string,
      companyId: data.company_id as string,
      origin: data.origin as string,
      returnTo: (data.return_to as string | null) ?? null,
      startedAt: new Date(data.created_at as string).getTime(),
      usedAt: new Date(data.used_at as string).getTime(),
    },
  }
}

/**
 * Why a handoff was refused, for the log. A claimed handoff is gone (the
 * claim removes it), so it reads as unknown, like one that never existed.
 */
export type OAuthFlowHandoffRefusal =
  | 'handoff_unknown'
  | 'handoff_expired'
  | 'handoff_wrong_origin'
  | 'lookup_failed'

/** Same as inspectOAuthFlowState, for a handoff refused on `origin`. Never a gate. */
export async function inspectOAuthFlowHandoff(
  db: SupabaseClient,
  handoffId: string,
  origin: string,
  kind: OAuthFlowKind,
): Promise<OAuthFlowHandoffRefusal> {
  const { data, error } = await db
    .from('oauth_flows')
    .select('origin, handoff_expires_at')
    .eq('handoff_id', handoffId)
    .eq('kind', kind)
    .maybeSingle()
  if (error) return 'lookup_failed'
  if (!data) return 'handoff_unknown'
  if (new Date(data.handoff_expires_at as string).getTime() <= Date.now()) return 'handoff_expired'
  if (data.origin !== origin) return 'handoff_wrong_origin'
  // Live and on this origin: the refusal was a failed read, not the handoff.
  return 'lookup_failed'
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

type ClaimedHandoffRow = FlowRow & {
  created_at: string
  expires_at: string
  used_at: string
  handoff_code: string | null
  handoff_error: string | null
}

/**
 * Put back what is left of a flow once its handoff is claimed: who started
 * it, where it finishes, and when it was started and used. No verifier, no
 * connector state, no provider result. Consumed and without a handoff, so no
 * consume can match it again; purged with the rest an hour after expiry.
 * Best-effort: without it a second delivery of the same provider redirect is
 * refused as unknown, which is what happened before it existed.
 */
async function keepSpentOAuthFlow(db: SupabaseClient, row: ClaimedHandoffRow): Promise<void> {
  try {
    const { error } = await db.from('oauth_flows').insert({
      id: row.id,
      kind: row.kind,
      company_id: row.company_id,
      user_id: row.user_id,
      origin: row.origin,
      redirect_uri: row.redirect_uri,
      return_to: row.return_to,
      created_at: row.created_at,
      expires_at: row.expires_at,
      used_at: row.used_at,
    })
    if (error) log.warn('spent oauth flow could not be kept', { error: error.message })
  } catch (err) {
    log.warn('spent oauth flow could not be kept', { error: (err as Error).message })
  }
}

/**
 * Hop 2: claim the handoff once, only from the origin it was minted for.
 * DELETE RETURNING, so the held provider code leaves the database the moment
 * it is read; the row comes back as a spent row without it
 * (keepSpentOAuthFlow). Null for every failure, including unreadable
 * ciphertext.
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
    .select(`${FLOW_COLUMNS}, created_at, expires_at, used_at, handoff_code, handoff_error`)
    .maybeSingle()
  if (error || !data) return null
  const row = data as ClaimedHandoffRow
  await keepSpentOAuthFlow(db, row)
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
