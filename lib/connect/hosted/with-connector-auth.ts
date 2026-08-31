import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, after } from 'next/server'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger, type Logger } from '@/lib/logger'
import { CONNECTOR_KEY_HEADER, CONNECTOR_KEY_PREFIX } from '../contract'
import { validateConnectorKey, type ValidatedConnectorKey } from './keys'

/**
 * Wrapper for the hosted connector endpoints (app/api/connect/*), the
 * connector twin of lib/api/v1/with-api-v1.ts.
 *
 *   1. Extracts the key from `Authorization: Bearer gnubok_ck_...` or, for
 *      proxied calls where Authorization carries an upstream token, from
 *      `X-Connector-Key`.
 *   2. Validates it through the atomic RPC (rate-limited): 401 unknown /
 *      revoked, 403 suspended, 429 over the per-minute limit.
 *   3. Runs the handler with a service-role client and the validated key.
 *   4. Records one connector_usage_events row (metering, never blocking).
 *
 * These routes are reached by self-hosted instances with a key, never by a
 * browser session, so there is no cookie/MFA handling here; the proxy
 * middleware already lets /api/* through for bearer callers.
 */

export interface ConnectorContext {
  requestId: string
  log: Logger
  supabase: SupabaseClient
  key: ValidatedConnectorKey
}

type ConnectorHandler = (request: Request, ctx: ConnectorContext) => Promise<NextResponse | Response>

export function extractConnectorKey(request: Request): string | null {
  // A Bearer value is the connector credential only when it looks like one
  // (gnubok_ck_ prefix); otherwise it is an UPSTREAM token on a proxied call
  // and the connector key rides in X-Connector-Key. Hashing the upstream
  // token instead would 401 every such request. A non-prefixed Bearer with
  // no X-Connector-Key still falls through to the format check's 401.
  const auth = request.headers.get('authorization')
  const bearer = auth?.startsWith('Bearer ') ? auth.slice(7).trim() || null : null
  if (bearer?.startsWith(CONNECTOR_KEY_PREFIX)) return bearer
  const header = request.headers.get(CONNECTOR_KEY_HEADER)
  if (header?.trim()) return header.trim()
  return bearer
}

export function withConnectorAuth(
  operation: string,
  handler: ConnectorHandler,
  options: { service?: string } = {},
): (request: Request) => Promise<Response> {
  const service = options.service ?? operation.split('.')[1] ?? operation
  return async function wrapped(request: Request): Promise<Response> {
    const requestId = `conn_${crypto.randomUUID()}`
    const log = createLogger(`connect/${operation}`, { requestId, operation })
    const supabase = createServiceClientNoCookies()

    const presented = extractConnectorKey(request)
    if (!presented) {
      return NextResponse.json(
        { error: 'Missing connector key', code: 'CONNECTOR_KEY_MISSING' },
        { status: 401, headers: { 'X-Request-Id': requestId } },
      )
    }
    const validation = await validateConnectorKey(presented, supabase)
    if (!validation.ok) {
      log.warn('connector auth rejected', { code: validation.code })
      return NextResponse.json(
        { error: validation.error, code: validation.code },
        { status: validation.status, headers: { 'X-Request-Id': requestId } },
      )
    }

    let response: Response
    try {
      response = await handler(request, { requestId, log, supabase, key: validation.key })
    } catch (err) {
      log.error('connector handler failed', err)
      response = NextResponse.json(
        { error: 'Internal error', code: 'INTERNAL_ERROR' },
        { status: 500 },
      )
    }
    response.headers.set('X-Request-Id', requestId)

    // Metering: one row per request, never on the critical path.
    const endpoint = (() => {
      try {
        return new URL(request.url).pathname
      } catch {
        return null
      }
    })()
    const recordUsage = async (): Promise<void> => {
      const { error: usageError } = await supabase.from('connector_usage_events').insert({
        connector_key_id: validation.key.id,
        service,
        endpoint,
        status_code: response.status,
      })
      if (usageError) log.warn('usage event not recorded', { err: usageError.message })
    }
    try {
      // Off the response path: the caller should not wait on metering.
      // Same pattern as lib/webhooks/dispatch-kick.ts.
      after(() => recordUsage())
    } catch {
      // Outside a request scope (unit tests): record inline.
      await recordUsage()
    }

    return response
  }
}
