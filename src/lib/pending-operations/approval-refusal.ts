/**
 * A refused approval, as a person reads it in the app (tracker #206 point 2).
 *
 * The executors behind an approval answer agents and people with the same
 * sentence, so some of them name tools, arguments and raw codes ("kör om med
 * allow_duplicate=true", "(gnubok_match_transaction_to_invoice)",
 * "ENTRY_NOT_OPEN"). The agent doors keep those words: they are the agent's
 * next step. The app's approval strips them here, and reads from the route's
 * answer whether the proposal is still waiting or was closed by the refusal.
 *
 * Client-safe: the approvals page reads a route answer and a history row
 * through it, the commit route writes its answer with it.
 */
import { getErrorMessage, isSwedishUserMessage } from '@/lib/errors/get-error-message'

/** A tool name in brackets after the sentence it belongs to: dropped, the sentence stays. */
const TOOL_NAME_IN_BRACKETS = /\s*\((?:gnubok|accounted)_[a-z0-9_]+\)/g

/**
 * An identifier written for a machine: a tool name, an argument
 * (allow_duplicate=true), a column, a raw code (ENTRY_NOT_OPEN). Swedish
 * prose has no underscore inside a word.
 */
const MACHINE_WORD = /[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*[A-Za-z0-9]/

/**
 * The refusal without the sentences written for an agent. A sentence that
 * names a machine word is dropped whole (half of it would not read); what is
 * left may be empty.
 */
export function stripAgentWording(raw: string | null | undefined): string {
  if (!raw) return ''
  return raw
    .replace(TOOL_NAME_IN_BRACKETS, '')
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !MACHINE_WORD.test(sentence))
    .join(' ')
    .trim()
}

/**
 * The executor's own sentence when it is Swedish written for a person, else
 * null: the caller then answers with the registry's sentence for the code,
 * or the sentence for the status.
 */
export function personRefusalText(raw: string | null | undefined): string | null {
  const cleaned = stripAgentWording(raw)
  return cleaned && isSwedishUserMessage(cleaned) ? cleaned : null
}

export interface ApprovalRefusal {
  /** The structured code, when the refusal has one. */
  code: string | null
  /** Swedish, for a person. */
  message: string
  /**
   * The refusal closed the proposal: approving it again cannot work, and the
   * page must not offer it. False when it still waits, or when the route did
   * not say (a session or permission answer from the route guard).
   */
  closed: boolean
  details: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** The commit route's refusal, from its parsed body and status. */
export function readApprovalRefusal(json: unknown, statusCode: number): ApprovalRefusal {
  const body = asRecord(json)
  const error = asRecord(body.error)
  const details = asRecord(error.details)
  const operationStatus = details.operation_status ?? body.operation_status
  return {
    code: typeof error.code === 'string' ? error.code : null,
    message: getErrorMessage(json, { statusCode }),
    closed: operationStatus === 'rejected' || operationStatus === 'failed_partial',
    details,
  }
}

/**
 * Why a proposal in the history was closed by a refused approval, for a
 * person: the stored reason (result_data.reason on an automatic rejection,
 * result_data.error otherwise) without agent wording. Null when the proposal
 * was not closed that way or nothing readable is stored.
 */
export function closedByRefusalReason(operation: {
  status: string
  rejection_category?: string | null
  result_data?: unknown
}): string | null {
  if (operation.status !== 'rejected' || operation.rejection_category !== 'failed') return null
  const stored = asRecord(operation.result_data)
  const raw = typeof stored.reason === 'string' ? stored.reason : typeof stored.error === 'string' ? stored.error : null
  return personRefusalText(raw)
}
