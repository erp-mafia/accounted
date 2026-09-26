import { getRedis } from '@/lib/auth/rate-limit-http'
import { isSelfHosted } from '@/lib/env/public-flags'

/**
 * Unattended MCP runs: a scheduled routine calls get_task with
 * `unattended: true`, and from then on it may read and stage but never
 * approve or commit. The routine's text says so too, but text can be
 * overridden by whatever the AI reads next (a skill, a document), so the
 * server enforces it.
 *
 * The mark goes on the run's Mcp-Session-Id when the client sends one, and
 * otherwise on the whole API key for two hours: fail closed, at the price
 * that approvals through that key wait for Accounted's own UI meanwhile. The
 * session header is not trusted for authorization and is not used for it: a
 * mark only ever takes rights away.
 *
 * Marks live in Upstash, shared by every server instance. Memory is only a
 * fallback where one process serves everything (self-hosted, and tests): on
 * a hosted deployment a mark in one instance's memory would not hold back a
 * call routed to another, so there an unattended run without Upstash is
 * refused instead (markUnattended throws, and the dispatcher refuses the run).
 */
export const SESSION_TTL_SECONDS = 6 * 60 * 60
export const KEY_TTL_SECONDS = 2 * 60 * 60
const PREFIX = 'mcp:unattended:'
const memory = new Map<string, number>()

export type UnattendedScope = `session:${string}` | `key:${string}`

/** Where an unattended get_task puts its mark: the session when there is one, else the key. */
export function unattendedScope(sessionId: string | null | undefined, keyId: string | null | undefined): { scope: UnattendedScope; ttl: number } | null {
  if (sessionId) return { scope: `session:${sessionId}`, ttl: SESSION_TTL_SECONDS }
  if (keyId) return { scope: `key:${keyId}`, ttl: KEY_TTL_SECONDS }
  return null
}

/** Every mark that can hold a call back: its session's and its key's. */
export function unattendedScopes(sessionId: string | null | undefined, keyId: string | null | undefined): UnattendedScope[] {
  return [
    ...(sessionId ? [`session:${sessionId}` as const] : []),
    ...(keyId ? [`key:${keyId}` as const] : []),
  ]
}

/** Whether a mark kept in this process's memory is enough: one process serves every call. */
function memoryIsShared(): boolean {
  return isSelfHosted() || process.env.NODE_ENV === 'test'
}

export async function markUnattended(scope: UnattendedScope, ttlSeconds: number): Promise<void> {
  const redis = getRedis()
  if (redis) {
    await redis.set(`${PREFIX}${scope}`, '1', { ex: ttlSeconds })
    return
  }
  if (!memoryIsShared()) throw new Error('No shared store for unattended marks (Upstash is not configured)')
  memory.set(scope, Date.now() + ttlSeconds * 1000)
}

export async function isAnyUnattended(scopes: UnattendedScope[]): Promise<boolean> {
  if (scopes.length === 0) return false
  const redis = getRedis()
  if (redis) {
    const values = await redis.mget<(string | null)[]>(...scopes.map((s) => `${PREFIX}${s}`))
    return values.some((v) => v !== null)
  }
  const now = Date.now()
  return scopes.some((scope) => {
    const until = memory.get(scope)
    if (until === undefined) return false
    if (until < now) {
      memory.delete(scope)
      return false
    }
    return true
  })
}

/** Tests only. */
export function resetUnattendedForTests(): void {
  memory.clear()
}
