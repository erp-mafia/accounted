/**
 * Helpers for shaping MCP tool results in an agent-actionable form.
 *
 * Two additive concepts:
 *   1. `next` (NextActionHint): when a tool succeeds and there's an obvious
 *      follow-up tool or resource the agent should call, expose it directly
 *      so Claude doesn't have to re-derive it from prose.
 *   2. structured errors: failures include a stable code, English + Swedish
 *      messages, and a remediation hint when one exists.
 *
 * Both are folded into the JSON `text` payload that the JSON-RPC handler
 * already serializes: no protocol change needed, and existing string-only
 * consumers keep working.
 */
import { getStructuredError, type StructuredError } from '@/lib/errors/get-structured-error'

export interface NextActionHint {
  description: string
  tool?: string
  args?: Record<string, unknown>
  resource?: string
}

export interface AgentToolError {
  error: StructuredError & { details?: Record<string, unknown> }
}

/**
 * The refusals whose details ARE the agent's next step, so they ride in the
 * envelope as `error.details` (where v1 carries them too). Every other
 * failure keeps the bare structured error. PREVIEW_STALE carries the fresh
 * preview and its token, which the agent must show the person before it may
 * stage again (lib/operations/preview-token.ts).
 */
const CODES_WITH_DETAILS = new Set(['PREVIEW_STALE'])

/**
 * Convert a thrown error into the structured tool-error envelope the agent
 * sees. If the error is a string already containing "Insufficient scope:",
 * the attempted scope is propagated to the remediation hint so the agent can
 * surface a precise request to the user.
 */
export function toToolError(err: unknown, opts: { toolName?: string } = {}): AgentToolError {
  let attemptedScope: string | undefined
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const scopeMatch = message.match(/Insufficient scope: this API key does not have the "([^"]+)" scope/)
  if (scopeMatch) attemptedScope = scopeMatch[1]

  const error = getStructuredError(err, { attemptedScope, toolName: opts.toolName })
  const details = CODES_WITH_DETAILS.has(error.code) ? ownDetails(err) : undefined
  return { error: details ? { ...error, details } : error }
}

function ownDetails(err: unknown): Record<string, unknown> | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const details = (err as { details?: unknown }).details
  return typeof details === 'object' && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>)
    : undefined
}
