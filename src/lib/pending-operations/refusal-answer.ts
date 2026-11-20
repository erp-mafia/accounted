/**
 * The sentences and the next step a refused approval answers with, read from
 * the commit result. A refusal that keeps a published code but speaks
 * another registry entry's answer (attach-document on a locked year:
 * PERIOD_LOCKED with DOC_UPLOAD_PERIOD_LOCKED's) brings its own English and
 * next step in the result's data, beside its Swedish sentence as the error
 * (commitRegisteredOperation; the SIE executor brings its remediation the
 * same way). Every other refusal brings none, and the door answers the
 * registry's for the code.
 *
 * One reading for the doors that answer an approval with a code: the v1
 * approve route and the app's commit route spread the answer into
 * v1ErrorResponseFromCode / errorResponseFromCode, which fill whatever is
 * missing from the registry entry for the code.
 */
import type { StructuredErrorRemediation } from '@/lib/errors/structured-errors'
import type { CommitResult } from './commit'

export interface CommitRefusalAnswer {
  /** The refusal's own Swedish sentence; only given together with its English. */
  messageSv?: string
  messageEn?: string
  /** Replaces the registry's next step for the code. */
  remediation?: StructuredErrorRemediation
}

function isRemediation(value: unknown): value is StructuredErrorRemediation {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { description?: unknown }).description === 'string' &&
    (value as { description: string }).description.trim() !== ''
  )
}

/**
 * The refusal's own answer, or an empty object when it brought none. The
 * sentences come as a pair: a Swedish error alone is no reason to replace
 * the registry's English, which would then say something else.
 */
export function commitRefusalAnswer(result: Pick<CommitResult, 'error' | 'data'>): CommitRefusalAnswer {
  const data = result.data ?? {}
  const messageEn = typeof data.message_en === 'string' && data.message_en.trim() !== '' ? data.message_en : null
  const messageSv = typeof result.error === 'string' && result.error.trim() !== '' ? result.error : null
  return {
    ...(messageSv && messageEn ? { messageSv, messageEn } : {}),
    ...(isRemediation(data.remediation) ? { remediation: data.remediation } : {}),
  }
}
