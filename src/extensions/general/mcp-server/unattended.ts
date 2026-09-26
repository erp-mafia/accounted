import { getRedis } from '@/lib/auth/rate-limit-http'

/**
 * Unattended MCP sessions: a scheduled routine calls get_task with
 * `unattended: true`, and from then on its session may read and stage but
 * never commit. The routine's text says so too, but text can be overridden by
 * whatever the AI reads next (a skill, a document), so the server enforces it.
 *
 * Keyed on the client's Mcp-Session-Id. That header is not trusted for
 * authorization, and it is not used for it here: a mark only ever takes
 * rights away. A client that sends no session id gets no mark, and then only
 * the routine's own text stands between it and a commit.
 *
 * Marks live in Upstash for the length of a run (shared by every server
 * instance), or in memory where Upstash is not configured (self-hosted, one
 * instance, and tests).
 */
const TTL_SECONDS = 6 * 60 * 60
const PREFIX = 'mcp:unattended:'
const memory = new Map<string, number>()

export async function markUnattended(sessionId: string): Promise<void> {
  const redis = getRedis()
  if (redis) {
    await redis.set(`${PREFIX}${sessionId}`, '1', { ex: TTL_SECONDS })
    return
  }
  memory.set(sessionId, Date.now() + TTL_SECONDS * 1000)
}

export async function isUnattended(sessionId: string): Promise<boolean> {
  const redis = getRedis()
  if (redis) return (await redis.get(`${PREFIX}${sessionId}`)) !== null
  const until = memory.get(sessionId)
  if (until === undefined) return false
  if (until < Date.now()) {
    memory.delete(sessionId)
    return false
  }
  return true
}

/** Tests only. */
export function resetUnattendedForTests(): void {
  memory.clear()
}
