import { NextResponse } from 'next/server'
import { withConnectorAuth, type ConnectorContext } from '@/lib/connect/hosted/with-connector-auth'
import { getAuthorizationHeader } from '@/lib/connect/upstreams/enable-banking-jwt'
import { reserveUpstream } from '@/lib/connect/hosted/upstream-budget'
import {
  activateByPendingState,
  countHeldConnections,
  createPendingConnection,
  deletePendingConnectionById,
  findByAccountUid,
  findByHandle,
  findPendingByState,
  revokeByHandle,
  touchConnection,
} from '@/lib/connect/hosted/ledger'
import { signConnectorState, verifyConnectorState } from '@/lib/connect/hosted/state'

/**
 * Enable Banking proxy for self-hosted instances (WS3 PR5).
 *
 * The instance calls this with its connector key; the proxy adds Arcim's EB
 * JWT and forwards to Enable Banking. The instance never holds the EB
 * credential; the bank session id it gets back rests on the instance. This
 * route is what makes that split safe: a strict path allowlist (never an open
 * passthrough), per-key + global rate budget on every upstream call, a
 * per-company connection quota checked at authorize time, and an ownership
 * ledger so an instance can only use sessions/accounts it obtained through its
 * own key.
 *
 * Consent handoff: POST /auth's redirect_url is rewritten to OUR hosted EB
 * callback (already registered with EB), and the upstream `state` is replaced
 * by a signed connector state carrying the instance's own return URL. The
 * hosted EB callback (app/api/extensions/enable-banking/callback) detects that
 * signed state and 302s the browser back to the instance with the code, so no
 * new redirect URI has to be registered at Enable Banking per instance.
 */

/**
 * The EB base URL must be https (http only for loopback dev): forwardToEb
 * sends Arcim's EB JWT in Authorization, so a plaintext override would ship
 * the credential unencrypted. Resolved lazily so a bad env fails the request
 * (500 via the wrapper), never the build.
 */
function ebBaseUrl(): string {
  const raw = (
    process.env.ENABLE_BANKING_API_URL_PRODUCTION ||
    process.env.ENABLE_BANKING_API_URL ||
    'https://api.enablebanking.com'
  ).replace(/\/+$/, '')
  const url = new URL(raw)
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1'
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('ENABLE_BANKING_API_URL must be https: the EB JWT is sent in Authorization')
  }
  return raw
}

const COMPANY_HEADER = 'x-connector-company'
const FETCH_TIMEOUT_MS = 30_000

function requireScope(ctx: ConnectorContext): NextResponse | null {
  if (ctx.key.scopes.includes('bank_sync')) return null
  return NextResponse.json(
    { error: 'This connector key does not include bank sync', code: 'CONNECTOR_SCOPE_MISSING' },
    { status: 403 },
  )
}

function companyRef(request: Request): string | null {
  return request.headers.get(COMPANY_HEADER)?.trim() || null
}

async function budgetOr429(ctx: ConnectorContext): Promise<NextResponse | null> {
  const budget = await reserveUpstream(ctx.supabase, 'bank')
  if (budget.ok) return null
  ctx.log.warn('bank connector budget exhausted', { scope: budget.scope })
  return NextResponse.json(
    { error: 'Bank connector is busy, try again shortly', code: 'CONNECTOR_RATE_LIMITED', scope: budget.scope },
    { status: 429, headers: { 'Retry-After': String(budget.retryAfterSec) } },
  )
}

// Statuses that must carry no body (RFC 9110). new Response(text, {status:204})
// throws in undici, so pass a null body through for these.
const NULL_BODY_STATUS = new Set([204, 205, 304])

interface EbResult {
  status: number
  ok: boolean
  /** null for the RFC 9110 bodyless statuses. */
  text: string | null
  contentType: string | null
}

/**
 * Forward a request to Enable Banking with Arcim's JWT and read the body
 * INSIDE the timeout window: clearing the timer at headers-received left an
 * upstream that stalls mid-body holding the request open forever.
 */
async function forwardToEb(method: string, path: string, body?: unknown): Promise<EbResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(`${ebBaseUrl()}${path}`, {
      method,
      signal: controller.signal,
      // A followed redirect would resend the EB JWT to the redirect target.
      redirect: 'error',
      headers: {
        Authorization: getAuthorizationHeader(),
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    const text = NULL_BODY_STATUS.has(res.status) ? null : await res.text()
    return { status: res.status, ok: res.ok, text, contentType: res.headers.get('content-type') }
  } finally {
    clearTimeout(timeout)
  }
}

function passthrough(res: EbResult): NextResponse {
  if (res.text === null) {
    return new NextResponse(null, { status: res.status })
  }
  return new NextResponse(res.text, {
    status: res.status,
    headers: { 'Content-Type': res.contentType ?? 'application/json' },
  })
}

function pathOf(request: Request): string {
  const idx = request.url.indexOf('/api/connect/bank')
  const rest = idx === -1 ? '' : request.url.slice(idx + '/api/connect/bank'.length)
  return rest.split('?')[0].replace(/\/+$/, '') || '/'
}
function queryOf(request: Request): string {
  const q = request.url.indexOf('?')
  return q === -1 ? '' : request.url.slice(q)
}

const HOSTED_EB_CALLBACK = () =>
  `${(process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/+$/, '')}/api/extensions/enable-banking/callback`

export const GET = withConnectorAuth('connect.bank', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  const path = pathOf(request)

  // GET /aspsps — bank list. Rate-budgeted, no ownership.
  if (path === '/aspsps') {
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    return passthrough(await forwardToEb('GET', `/aspsps${queryOf(request)}`))
  }

  // GET /sessions/{id} — must own the session.
  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path)
  if (sessionMatch) {
    const sessionId = decodeURIComponent(sessionMatch[1])
    const owned = await findByHandle(ctx.supabase, { keyId: ctx.key.id, service: 'bank', handle: sessionId })
    if (!owned) return notOwned()
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    await touchConnection(ctx.supabase, owned.id)
    return passthrough(await forwardToEb('GET', `/sessions/${encodeURIComponent(sessionId)}`))
  }

  // GET /accounts/{uid}/balances|transactions — must own the account.
  const acctMatch = /^\/accounts\/([^/]+)\/(balances|transactions)$/.exec(path)
  if (acctMatch) {
    const uid = decodeURIComponent(acctMatch[1])
    const owned = await findByAccountUid(ctx.supabase, { keyId: ctx.key.id, accountUid: uid })
    if (!owned) return notOwned()
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    await touchConnection(ctx.supabase, owned.id)
    return passthrough(await forwardToEb('GET', `/accounts/${encodeURIComponent(uid)}/${acctMatch[2]}${queryOf(request)}`))
  }

  return notAllowed()
})

export const POST = withConnectorAuth('connect.bank', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  const path = pathOf(request)
  const cref = companyRef(request)

  // POST /auth — start a bank authorization for one company.
  if (path === '/auth') {
    if (!cref) return missingCompany()
    let payload: Record<string, unknown>
    try {
      payload = (await request.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON', code: 'BAD_REQUEST' }, { status: 400 })
    }
    const instanceReturn = typeof payload.redirect_url === 'string' ? payload.redirect_url : null
    if (!instanceReturn || !isOnInstance(instanceReturn, ctx.key.instanceUrl)) {
      return NextResponse.json(
        { error: 'redirect_url must be on the connector key\'s instance', code: 'CONNECTOR_REDIRECT_INVALID' },
        { status: 400 },
      )
    }
    // Per-company connection quota (the sold package). Counting alone is a
    // TOCTOU race under concurrent /auth calls, so the pending row doubles as
    // a reservation: fast-reject on the pre-count, insert, then RE-count and
    // roll the own row back when over the limit. Fresh pending rows reserve
    // quota for the 15-minute consent window (see countHeldConnections).
    const quotaExceeded = () =>
      NextResponse.json(
        {
          error: 'Bank connection quota reached for this company',
          code: 'CONNECTOR_QUOTA_EXCEEDED',
          limit: ctx.key.limits.bank_connections_per_company,
        },
        { status: 403 },
      )
    const held = await countHeldConnections(ctx.supabase, ctx.key.id, 'bank', cref)
    if (held >= ctx.key.limits.bank_connections_per_company) return quotaExceeded()
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked

    const instanceState = typeof payload.state === 'string' ? payload.state : ''
    const signedState = signConnectorState({ kid: ctx.key.id, svc: 'bank', ret: instanceReturn, st: instanceState, cref })
    const provider = typeof (payload.aspsp as { name?: string } | undefined)?.name === 'string'
      ? String((payload.aspsp as { name: string }).name)
      : null
    const pendingId = await createPendingConnection(ctx.supabase, {
      keyId: ctx.key.id,
      service: 'bank',
      companyRef: cref,
      provider,
      pendingState: signedState,
    })
    const heldAfter = await countHeldConnections(ctx.supabase, ctx.key.id, 'bank', cref)
    if (heldAfter > ctx.key.limits.bank_connections_per_company) {
      await deletePendingConnectionById(ctx.supabase, pendingId)
      return quotaExceeded()
    }
    // Rewrite the redirect to OUR registered callback and swap in the signed state.
    const ebBody = { ...payload, redirect_url: HOSTED_EB_CALLBACK(), state: signedState }
    return passthrough(await forwardToEb('POST', '/auth', ebBody))
  }

  // POST /sessions — finalize after consent, record the session in the ledger.
  if (path === '/sessions') {
    let payload: Record<string, unknown>
    try {
      payload = (await request.json()) as Record<string, unknown>
    } catch {
      return NextResponse.json({ error: 'Invalid JSON', code: 'BAD_REQUEST' }, { status: 400 })
    }
    // The instance sends back the signed connector state it received. The
    // code is only exchanged AGAINST that state's own pending row: verified
    // signature, this key, bank service, and the row still pending. Without
    // the binding, a code could be exchanged under a foreign or consumed
    // state, minting an upstream session the ledger never records.
    const pendingState = typeof payload.connector_state === 'string' ? payload.connector_state : null
    if (!pendingState) {
      return NextResponse.json({ error: 'Missing connector_state', code: 'BAD_REQUEST' }, { status: 400 })
    }
    const verified = verifyConnectorState(pendingState)
    if (!verified.ok) {
      return NextResponse.json({ error: 'Invalid connector state', code: 'CONNECTOR_STATE_INVALID' }, { status: 400 })
    }
    if (verified.payload.kid !== ctx.key.id || verified.payload.svc !== 'bank') {
      return NextResponse.json({ error: 'State does not belong to this key', code: 'CONNECTOR_STATE_INVALID' }, { status: 403 })
    }
    const pendingRow = await findPendingByState(ctx.supabase, { keyId: ctx.key.id, pendingState })
    if (!pendingRow) return notOwned()
    const blocked = await budgetOr429(ctx)
    if (blocked) return blocked
    const ebRes = await forwardToEb('POST', '/sessions', { code: payload.code })
    if (ebRes.ok && ebRes.text !== null) {
      try {
        const session = JSON.parse(ebRes.text) as { session_id?: string; accounts?: Array<{ uid?: string }> }
        if (session.session_id) {
          const accountUids = (session.accounts ?? [])
            .map((a) => a.uid)
            .filter((u): u is string => typeof u === 'string')
          const activated = await activateByPendingState(ctx.supabase, {
            keyId: ctx.key.id,
            pendingState,
            handle: session.session_id,
            accountUids,
          })
          if (!activated) {
            // The pending row was consumed between the precheck and now (a
            // concurrent replay of the same state). An unrecorded upstream
            // session must not be handed out: close it and refuse.
            await forwardToEb('DELETE', `/sessions/${encodeURIComponent(session.session_id)}`)
            return NextResponse.json(
              { error: 'Connector state already consumed', code: 'CONNECTOR_STATE_CONSUMED' },
              { status: 409 },
            )
          }
        }
      } catch (err) {
        ctx.log.warn('could not record session in ledger', { err: err instanceof Error ? err.message : String(err) })
      }
    }
    return passthrough(ebRes)
  }

  return notAllowed()
})

export const DELETE = withConnectorAuth('connect.bank', async (request, ctx) => {
  const scopeError = requireScope(ctx)
  if (scopeError) return scopeError
  const path = pathOf(request)
  const sessionMatch = /^\/sessions\/([^/]+)$/.exec(path)
  if (!sessionMatch) return notAllowed()
  const sessionId = decodeURIComponent(sessionMatch[1])
  const owned = await findByHandle(ctx.supabase, { keyId: ctx.key.id, service: 'bank', handle: sessionId })
  if (!owned) return notOwned()
  const blocked = await budgetOr429(ctx)
  if (blocked) return blocked
  const res = await forwardToEb('DELETE', `/sessions/${encodeURIComponent(sessionId)}`)
  // Revoke the ledger row only when the upstream delete actually took (or the
  // session is already gone upstream): revoking on a transient EB error would
  // leave the remote session alive but permanently unreachable via the proxy.
  if (res.ok || res.status === 404) {
    await revokeByHandle(ctx.supabase, { keyId: ctx.key.id, service: 'bank', handle: sessionId })
  }
  return passthrough(res)
})

function isOnInstance(url: string, instanceUrl: string | null): boolean {
  if (!instanceUrl) return false
  try {
    return new URL(url).origin === new URL(instanceUrl).origin
  } catch {
    return false
  }
}
function notAllowed(): NextResponse {
  return NextResponse.json({ error: 'Not allowed', code: 'CONNECTOR_PATH_NOT_ALLOWED' }, { status: 403 })
}
function notOwned(): NextResponse {
  return NextResponse.json({ error: 'Unknown connection for this key', code: 'CONNECTOR_NOT_OWNED' }, { status: 404 })
}
function missingCompany(): NextResponse {
  return NextResponse.json({ error: 'Missing X-Connector-Company header', code: 'CONNECTOR_COMPANY_MISSING' }, { status: 400 })
}
