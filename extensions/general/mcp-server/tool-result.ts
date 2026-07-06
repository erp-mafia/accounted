/**
 * Helpers for shaping MCP tool results in an agent-actionable form.
 *
 * Two additive concepts:
 *   1. `next`: when a tool succeeds and there's an obvious follow-up tool or
 *      resource the agent should call, expose it directly so Claude doesn't
 *      have to re-derive it from prose.
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

export interface AgentToolResult<T = unknown> {
  data: T
  next?: NextActionHint
}

export interface AgentToolError {
  error: StructuredError
}

/**
 * Wrap a successful tool payload with an optional `next` hint. Returns the
 * payload as-is if the input is already wrapped (idempotent), or a plain object
 * if no hint is supplied.
 */
export function withNext<T>(data: T, next?: NextActionHint): AgentToolResult<T> {
  return next ? { data, next } : { data }
}

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

  return {
    error: getStructuredError(err, { attemptedScope, toolName: opts.toolName }),
  }
}
