/**
 * `idempotency_key` for MCP tools that write without staging.
 *
 * A staging tool replays the key inside stagePendingOperation, and approving
 * twice is held off by the pending -> committing claim. A tool that writes
 * directly had neither: a client that resends a broken call (the stateless
 * MCP revision's recovery path) wrote twice. withRetryKey gives such a tool
 * the same contract the staging tools have, through the same table
 * (idempotency_keys, lib/api/idempotency.ts): the key is claimed per
 * (user, company, key) with a hash of the arguments before the tool runs, a
 * repeat with the same key and arguments returns the first answer with
 * `idempotency_replay: true` and runs nothing, the same key with other
 * arguments is IDEMPOTENCY_KEY_REUSE, and a repeat that arrives while the
 * first call still runs (a client resending a stream it saw break) is
 * IDEMPOTENCY_KEY_IN_PROGRESS (retryable) instead of a second write.
 *
 * It wraps execute, so every caller of the tool (the tools/call dispatcher,
 * the Tasks path) inherits it, and it declares the argument in inputSchema
 * itself, so the declaration and the handling cannot drift apart.
 *
 * Only a success is stored: a thrown failure releases the claim, and the
 * caller may retry it with the same key. A preview (a call that writes
 * nothing, such as dry_run) is neither looked up nor stored, so the real call
 * after it may reuse the key. No key, no change: there is no derived default,
 * because two calls with equal arguments can be two genuinely different
 * writes (two receipts with the same amount, two companies with one name).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { claimIdempotencyKey, hashRequest, type IdempotencyScope } from '@/lib/api/idempotency'
import type { ActorContext, McpTool } from './server'

/** The argument every key-taking write declares, staging or direct. */
export const IDEMPOTENCY_KEY_PROPERTY = {
  type: 'string',
  description: 'UUID: a retry with the same key and payload replays the first answer (24h).',
} as const

export interface RetryKeyOptions {
  /** True for a call that writes nothing (a preview): it runs uncached. */
  preview?: (args: Record<string, unknown>) => boolean
  /**
   * For a tool that has no company until it runs (gnubok_create_company):
   * the key is claimed per (user, scope) and the answer stored under the
   * company the result names. Without it the key is scoped to the call's
   * company, and a call with none (a company-independent tool on a user
   * with no company) runs uncached.
   */
  userScoped?: { scope: IdempotencyScope; companyFromResult: (result: Record<string, unknown>) => string | undefined }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A direct write that replays `idempotency_key`. */
export function withRetryKey(tool: McpTool, options: RetryKeyOptions = {}): McpTool {
  const properties = (tool.inputSchema.properties ?? {}) as Record<string, unknown>
  const run = tool.execute
  return {
    ...tool,
    retryKey: true,
    inputSchema: { ...tool.inputSchema, properties: { ...properties, idempotency_key: IDEMPOTENCY_KEY_PROPERTY } },
    async execute(
      args: Record<string, unknown>,
      companyId: string,
      userId: string,
      supabase: SupabaseClient,
      actor?: ActorContext,
    ): Promise<unknown> {
      const { idempotency_key: rawKey, ...rest } = args
      const key = typeof rawKey === 'string' ? rawKey.trim() : ''
      const scoped = options.userScoped
      if (!key || options.preview?.(rest) || (!scoped && !companyId)) {
        return run(rest, companyId, userId, supabase, actor)
      }

      // Private dispatcher fields (__keyScopes, ...) are not the caller's payload.
      const payload = Object.fromEntries(Object.entries(rest).filter(([name]) => !name.startsWith('__')))
      const requestHash = hashRequest({ tool: tool.name, args: payload, ...(scoped ? {} : { companyId }) })
      // Throws IDEMPOTENCY_KEY_REUSE / IDEMPOTENCY_KEY_IN_PROGRESS, which the
      // dispatcher answers in the structured tool-error shape.
      const outcome = await claimIdempotencyKey(supabase, {
        userId,
        companyId: scoped ? null : companyId,
        scope: scoped ? scoped.scope : 'mcp_tool',
        key,
        requestHash,
      })
      if ('replay' in outcome) return { ...outcome.replay.body, idempotency_replay: true }

      const { claim } = outcome
      let result: unknown
      try {
        result = await run(rest, companyId, userId, supabase, actor)
      } catch (err) {
        await claim.release()
        throw err
      }
      const storeUnder = isRecord(result) ? (scoped ? scoped.companyFromResult(result) : companyId) : undefined
      if (isRecord(result) && storeUnder) {
        await claim.complete('success', result, scoped ? { companyId: storeUnder } : {})
      } else {
        // Nothing to replay (no record, or no company created): a retry runs again.
        await claim.release()
      }
      return result
    },
  }
}
