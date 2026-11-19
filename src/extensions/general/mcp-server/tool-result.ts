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
import type { CapabilityBlockedError } from '@/lib/entitlements/has-capability'

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
 * stage again (lib/operations/preview-token.ts). TRANSACTION_ALREADY_STAGED
 * names the open operations to approve or reject first
 * (lib/pending-operations/transaction-claims.ts).
 * PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE names why the account cannot pay
 * (details.reason: account_disabled, not_sek, iban_missing, bank_unknown,
 * bank_not_supported),
 * which the message alone cannot tell apart (crm#1314).
 * SALARY_RUN_VACATION_PAY_UNDETERMINED names each employee whose vacation
 * days cannot be priced, with the reason in English (issue #85).
 * VOUCHER_NEEDS_CONFIRMATION carries the booking-time warnings the person
 * must see before a voucher is staged again with acknowledged_warnings
 * (lib/bookkeeping/voucher-warnings-guard.ts).
 * FORBIDDEN carries why: details.code ROLE_READ_ONLY or CONNECTION_READ_ONLY
 * (readOnlyRefusal, the same on every door), details.required_roles for an
 * owner's or admin's write.
 * DOC_ATTACH_OTHER_VERIFIKAT names the verifikat that holds the document, the
 * one the row is booked on and, in details.next, the link with copy: true
 * that puts the same underlag on it (crm#1813).
 * RATE_LIMITED carries details.retry_after_seconds and
 * details.limit_per_minute when a key is over its per-minute limit (#225).
 */
const CODES_WITH_DETAILS = new Set([
  'DOC_ATTACH_OTHER_VERIFIKAT',
  'FORBIDDEN',
  'PREVIEW_STALE',
  'RATE_LIMITED',
  'TRANSACTION_ALREADY_STAGED',
  'PAYMENT_ORDERS_ACCOUNT_NOT_PAYABLE',
  'SALARY_RUN_VACATION_PAY_UNDETERMINED',
  'VOUCHER_NEEDS_CONFIRMATION',
])

/**
 * Convert a thrown error into the structured tool-error envelope the agent
 * sees. If the error is a string already containing "Insufficient scope:",
 * the attempted scope is propagated to the remediation hint so the agent can
 * surface a precise request to the user.
 */
export function toToolError(err: unknown, opts: { toolName?: string } = {}): AgentToolError {
  const blocked = capabilityBlockedOf(err)
  if (blocked) return { error: blocked }
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

/**
 * A paywall refusal a tool threw (capabilityBlockedRefusal), as the envelope
 * the dispatcher's capability gate answers: the legacy lowercase
 * capability_blocked is no registry code, so getStructuredError would read it
 * as UNKNOWN_ERROR, "Något gick fel. Försök igen.", for a call no retry fixes.
 */
function capabilityBlockedOf(err: unknown): CapabilityBlockedError | null {
  if (typeof err !== 'object' || err === null) return null
  const e = err as Partial<CapabilityBlockedError>
  if (e.capability_blocked !== true || e.code !== 'capability_blocked' || e.capability === undefined) return null
  if (typeof e.message_sv !== 'string' || typeof e.message_en !== 'string' || !e.remediation) return null
  return {
    code: 'capability_blocked',
    capability_blocked: true,
    capability: e.capability,
    message_sv: e.message_sv,
    message_en: e.message_en,
    retryable: false,
    remediation: e.remediation,
  }
}
