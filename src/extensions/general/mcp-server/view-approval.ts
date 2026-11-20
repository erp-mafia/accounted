import crypto from 'crypto'
import { sha256Key } from '@/lib/crypto/aes-gcm'
import { codedRefusal } from '@/lib/errors/refusal'
import { declaredClientExtensions } from './tasks'

/**
 * The approval view's own door: a click on Godkänn in Accounted's approval
 * view (the pending-operations widget, an MCP Apps view inside the AI client)
 * is recorded as a person's approval, while an approve call the AI makes
 * itself is recorded as the AI's. Without it the two were the same tool call
 * and every MCP approval read "Via API-nyckel" (customer request 2026-11-05:
 * the behandlingshistorik must tell "I approved in the chat" from "Claude
 * approved on its own").
 *
 * The server never sees the chat, so it cannot know whether a person said
 * yes there. What it can know is that a call came from the view, through
 * three locks the AI does not hold:
 *   1. The door is an app-only tool (`_meta.ui.visibility: ['app']`). A host
 *      that renders MCP Apps MUST leave it out of the model's tool list and
 *      MUST let only the view call it (MCP Apps 2026-01-26). Neither bridge
 *      carries it (gnubok_call_tool takes reads, gnubok_stage_tool staging
 *      writes) and search never returns it.
 *   2. Only a connection minted by the OAuth sign-in for a host that renders
 *      our views (api_keys.client, decided server-side from the validated
 *      redirect URI, never from a header) gets it listed and may call it,
 *      and not from a client that declares on the request that it renders
 *      no MCP Apps (a 2026-07-28 client lists its capabilities on every
 *      request; Claude Code reaches a Claude-minted connection that way).
 *   3. Every call carries a view token for that operation and that key. The
 *      server hands the tokens out only in the `_meta` of a rendered list
 *      result, which MCP Apps reserves for the view ("not intended for model
 *      context"); content and structuredContent never carry one.
 * A call that fails any lock is refused with VIEW_APPROVAL_UNAVAILABLE and
 * commits nothing, and the view falls back to the ordinary approve tool,
 * which records the approval as the AI's. Failing closed can understate a
 * person's click; it never records an AI's call as a person's.
 *
 * What the record claims is exactly this: a click in Accounted's approval
 * view inside the AI client, attested by that client. A first-party session
 * (approving under Att göra in Accounted) stays the stronger record.
 */

/** Canonical name of the app-only approve tool the view calls. */
export const VIEW_APPROVAL_TOOL = 'gnubok_approve_from_view'

/** Result `_meta` key the rendered list carries the view's tokens under. */
export const VIEW_APPROVAL_META_KEY = 'accounted/approval_view'

/** OAuth providers (api_keys.client) whose host renders the approval view. */
const VIEW_HOSTS: ReadonlySet<string> = new Set(['claude'])

/** How long a token from one rendered list stays good: a person may leave the view open a while. */
export const VIEW_TOKEN_TTL_SECONDS = 2 * 60 * 60

const PREFIX = 'va1'
const TOKEN_SHAPE = /^va1\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/

const MCP_APPS_EXTENSION = 'io.modelcontextprotocol/ui'

/**
 * Whether this request comes through a connection that has the approval
 * view: minted for a host that renders it, from a client that has not said
 * it renders no MCP Apps. A client that lists no capabilities on the request
 * (handshake-era: it declared them once, at initialize, which a stateless
 * server does not keep) is judged by the connection alone.
 */
export function approvalViewFor(input: { oauthProvider: string | null | undefined; requestMeta: unknown }): boolean {
  if (typeof input.oauthProvider !== 'string' || !VIEW_HOSTS.has(input.oauthProvider)) return false
  const extensions = declaredClientExtensions(input.requestMeta)
  return extensions === null || MCP_APPS_EXTENSION in extensions
}

/**
 * HMAC key under a purpose-scoped derivation of the server-only service-role
 * secret (the oauth-flow-crypto pattern): a token cannot be made without that
 * secret, and whoever holds it already controls the database.
 */
let derived: { secret: string; key: Buffer } | null = null

function signingKey(): Buffer {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!secret) throw codedRefusal('INTERNAL_ERROR', 'SUPABASE_SERVICE_ROLE_KEY is required')
  // Derived once per secret: a rendered list mints a token per operation.
  if (derived?.secret !== secret) derived = { secret, key: sha256Key('mcp-view-approval:v1:' + secret) }
  return derived.key
}

function sign(apiKeyId: string, operationId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', signingKey())
    .update(`${PREFIX}|${apiKeyId}|${operationId.toLowerCase()}|${expiresAt}`)
    .digest('base64url')
}

/** A token that lets the view approve one operation for one key until it expires. */
export function mintViewApprovalToken(input: { apiKeyId: string; operationId: string; now?: Date }): string {
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  const expiresAt = nowSeconds + VIEW_TOKEN_TTL_SECONDS
  return `${PREFIX}.${expiresAt}.${sign(input.apiKeyId, input.operationId, expiresAt)}`
}

export type ViewTokenCheck = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'expired' | 'mismatch' }

/** Whether `token` was minted for this key and this operation and is still good. */
export function checkViewApprovalToken(
  token: unknown,
  input: { apiKeyId: string; operationId: string; now?: Date },
): ViewTokenCheck {
  if (typeof token !== 'string' || token === '') return { ok: false, reason: 'missing' }
  const match = TOKEN_SHAPE.exec(token)
  if (!match) return { ok: false, reason: 'malformed' }
  const expiresAt = Number(match[1])
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  if (expiresAt < nowSeconds) return { ok: false, reason: 'expired' }
  const expected = Buffer.from(sign(input.apiKeyId, input.operationId, expiresAt))
  const given = Buffer.from(match[2])
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return { ok: false, reason: 'mismatch' }
  }
  return { ok: true }
}

/**
 * The `_meta` a rendered list result carries for the view: one token per
 * pending operation listed. Null when this connection has no approval view,
 * cannot approve, or nothing is pending. The view names the door itself (its
 * HTML is projected into the connection's tool namespace when it is read).
 */
export function approvalViewMeta(input: {
  /** approvalViewFor this request. */
  approvalView: boolean
  apiKeyId: string | null | undefined
  canApprove: boolean
  operations: ReadonlyArray<{ id?: unknown; status?: unknown }>
  now?: Date
}): Record<string, unknown> | null {
  if (!input.canApprove || !input.apiKeyId || !input.approvalView) return null
  const tokens: Record<string, string> = {}
  for (const op of input.operations) {
    if (typeof op.id !== 'string' || op.status !== 'pending') continue
    tokens[op.id] = mintViewApprovalToken({ apiKeyId: input.apiKeyId, operationId: op.id, now: input.now })
  }
  if (Object.keys(tokens).length === 0) return null
  return { [VIEW_APPROVAL_META_KEY]: { tokens } }
}
