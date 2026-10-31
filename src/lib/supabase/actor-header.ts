/**
 * Who acts, told to the database on every PostgREST request a service-role
 * client makes.
 *
 * A service-role request has no session: auth.uid() is NULL in its
 * transaction, so the audit triggers (write_audit_log, write_sie_header_audit)
 * could only fall back to the row's own user_id, its creator. A write made
 * for someone through a service-role client (an API key, the MCP server, the
 * invoicer role's scoped client, a route writing with the service client) was
 * logged under whoever created the row.
 *
 * The person and the credential are already known here: every door binds the
 * request's actor scope (runWithActor, lib/bookkeeping/actor-context.ts).
 * This fetch adds that actor to each PostgREST request as one header,
 * x-accounted-actor. PostgREST hands request headers to the transaction
 * (current_setting('request.headers')), where public.service_request_actor()
 * reads it for the triggers (migration 20261031120000). The database honours
 * it only on a service-role request: only the server holds that key, and a
 * user's own request is named by its JWT.
 *
 * The value is JSON with every character outside ASCII escaped as \uXXXX:
 * fetch refuses a header value outside Latin-1, and a key or service account
 * name is free text. Postgres parses the escapes back to the same text.
 *
 * Isomorphic: getActor() is undefined in a client bundle, so the fetch adds
 * nothing there.
 */
import { getActor, type CommitActor } from '@/lib/bookkeeping/actor-context'

/** The header the database reads (lower case, as PostgREST names it in request.headers). */
export const ACTOR_HEADER = 'x-accounted-actor'

/** The database keeps 200 characters of a label (service_request_actor). */
const LABEL_MAX = 200

/** A label that survives JSON and the database: well-formed, no control characters, capped. */
function cleanLabel(label: string | undefined): string | null {
  if (!label) return null
  const text = label.toWellFormed().replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return text ? Array.from(text).slice(0, LABEL_MAX).join('') : null
}

/**
 * The header value naming `actor` for the database, or null outside any
 * scope. A person is named by user_id alone: their label (an e-mail on the
 * approval door) would only repeat them.
 */
export function actorHeaderValue(actor: CommitActor | undefined): string | null {
  if (!actor) return null
  const value: { type: CommitActor['type']; user_id?: string; label?: string } = { type: actor.type }
  if (actor.userId) value.user_id = actor.userId
  const label = actor.type === 'user' ? null : cleanLabel(actor.label)
  if (label) value.label = label
  return JSON.stringify(value).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  )
}

function isPostgrestRequest(input: RequestInfo | URL): boolean {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  try {
    return new URL(url).pathname.includes('/rest/v1/')
  } catch {
    // Not an absolute URL, so not a PostgREST request: sent as is, nothing to name.
    return false
  }
}

/**
 * A fetch for supabase-js (global.fetch) that adds the current actor scope's
 * header to every PostgREST request. `base` is the fetch to send with, the
 * global one when absent, looked up per request (as supabase-js does) so a
 * fetch replaced later is the one used.
 */
export function withActorHeader(base?: typeof fetch): typeof fetch {
  return (input, init) => {
    const send = base ?? globalThis.fetch
    const value = actorHeaderValue(getActor())
    if (!value || !isPostgrestRequest(input)) return send(input, init)
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    headers.set(ACTOR_HEADER, value)
    return send(input, { ...init, headers })
  }
}
