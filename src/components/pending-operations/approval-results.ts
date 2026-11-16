/**
 * What the server answered to an approval that did not go through, kept per
 * proposal so the refusal is said where the proposal is (the queue, the list
 * row, the review's bar) and not only in a toast that has gone by then.
 *
 * Pure: the page records an answer here and reads it back. Nothing in this
 * file sends, retries or decides what an approval does. A proposal that left
 * the queue (approved, rejected, closed by its refusal) is no longer read.
 */

export type ApprovalFailureKind =
  /** The server answered and said no; its sentence is the message. */
  | 'refused'
  /** No answer came back (the request never reached the server). */
  | 'network'

export interface ApprovalFailure {
  kind: ApprovalFailureKind
  /** The sentence shown to the person: the server's own, or the network sentence. */
  message: string
  /** A fixable refusal's code (lib/pending-operations/fixable-refusals), where there is one. */
  fixCode?: string
}

export type ApprovalResults = Readonly<Record<string, ApprovalFailure>>

export const NO_APPROVAL_RESULTS: ApprovalResults = Object.freeze({})

/** A thrown fetch is a TypeError; an answer the page turned into an Error is the server's. */
export function failureKindOf(error: unknown): ApprovalFailureKind {
  return error instanceof TypeError ? 'network' : 'refused'
}

/** The latest answer for a proposal replaces the one before it. */
export function recordFailure(results: ApprovalResults, id: string, failure: ApprovalFailure): ApprovalResults {
  return { ...results, [id]: failure }
}

/** Several answers at once (a bulk approval's rows that were left undone). */
export function recordFailures(
  results: ApprovalResults,
  failures: ReadonlyArray<{ id: string; failure: ApprovalFailure }>,
): ApprovalResults {
  if (failures.length === 0) return results
  const next = { ...results }
  for (const { id, failure } of failures) next[id] = failure
  return next
}

/** An approval that went through (or a proposal that is settled) carries no failure. The same object when there was none. */
export function clearFailure(results: ApprovalResults, id: string): ApprovalResults {
  if (!(id in results)) return results
  const next = { ...results }
  delete next[id]
  return next
}

/** The failure of a proposal that still waits; null for one that is on its way again or has left the queue. */
export function failureOf(
  results: ApprovalResults,
  id: string | null | undefined,
  waiting: ReadonlySet<string>,
): ApprovalFailure | null {
  if (!id || !waiting.has(id)) return null
  return results[id] ?? null
}

/** The ids to mark in the queue and the list: failed and still waiting. */
export function failedIds(results: ApprovalResults, waiting: ReadonlySet<string>): ReadonlySet<string> {
  return new Set(Object.keys(results).filter((id) => waiting.has(id)))
}

/**
 * The record as kept for the browser tab, so it follows the person between
 * the list and the one-at-a-time review (two mounts of the page). Anything
 * that is not a record of failures reads as none.
 */
export function parseStoredResults(raw: string | null): ApprovalResults {
  if (!raw) return NO_APPROVAL_RESULTS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_APPROVAL_RESULTS
    const out: Record<string, ApprovalFailure> = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<ApprovalFailure> | null
      if (!entry || typeof entry.message !== 'string' || (entry.kind !== 'refused' && entry.kind !== 'network')) continue
      out[id] = { kind: entry.kind, message: entry.message, ...(typeof entry.fixCode === 'string' ? { fixCode: entry.fixCode } : {}) }
    }
    return out
  } catch {
    // Safe to drop: what the tab kept is only a copy of answers already
    // shown; text that is not JSON means there is nothing to show again.
    return NO_APPROVAL_RESULTS
  }
}
