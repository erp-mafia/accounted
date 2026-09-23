import { getErrorMessage, looksLikeUserFacingSwedish } from '@/lib/errors/get-error-message'
import type { SIEJob } from './sie-job-contract'

/**
 * Why an import stopped, in one shape for every surface that has to say it:
 * the SIE wizard, the migration wizard and the job progress card.
 *
 * Built from what the caller actually holds (a failed HTTP response, or a job
 * row that ended in failed/paused) and nothing else: the first sentence is
 * the server's own, the details are the lines the server attached (the
 * voucher that failed validation, the accounts without a target), and the
 * reference names the code, request and import so support can find the run
 * in the logs. Nothing here is a progress label: "Kontrollerar balansen:
 * något gick fel" (Easy Online Stores, 2026-09-16) was the theater's last
 * step plus the generic fallback, and said nothing about the empty voucher
 * outside the fiscal year that actually refused the file.
 */
export interface ImportFailure {
  /** The Swedish sentence to show first. */
  message: string
  /** The envelope's structured code or the legacy error tag, when any. */
  code: string | null
  requestId: string | null
  importId: string | null
  /** Per-voucher, per-account or per-row lines the server attached. */
  details: string[]
}

const MAX_DETAILS = 8

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** Free strings, or issue objects ({ field, message, sourceAccount }). */
function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') return item.trim() ? [item.trim()] : []
    if (!item || typeof item !== 'object') return []
    const message = asString((item as { message?: unknown }).message)
    if (!message) return []
    const source = asString((item as { sourceAccount?: unknown }).sourceAccount)
    const field = asString((item as { field?: unknown }).field)
    const label = source ? `Källkonto ${source}` : field
    return [label ? `${label}: ${message}` : message]
  })
}

function unmappedList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const account = asString((item as { account?: unknown }).account)
    if (!account) return []
    const name = asString((item as { name?: unknown }).name)
    return [`Konto ${account}${name ? ` (${name})` : ''} saknar målkonto`]
  })
}

/** Keep order, drop repeats and lines the first sentence already contains. */
function settleDetails(details: string[], message: string): string[] {
  const seen = new Set<string>()
  const kept: string[] = []
  for (const line of details) {
    if (seen.has(line) || message.includes(line)) continue
    seen.add(line)
    kept.push(line)
  }
  return kept.slice(0, MAX_DETAILS)
}

/**
 * Describe a failed import response. Reads the structured envelope
 * ({ error: { code, message, requestId, details } }) and the legacy shape the
 * older routes answer with ({ error: 'validation', message, unmappedAccounts }).
 * The first sentence goes through getErrorMessage like every other route
 * answer, so a known code keeps its registry text and the status fallbacks
 * still apply when the body is empty.
 */
export function describeImportResponseFailure(input: { status?: number; body: unknown }): ImportFailure {
  const { body, status } = input
  const failure: ImportFailure = {
    message: getErrorMessage(body, { statusCode: status }),
    code: null,
    requestId: null,
    importId: null,
    details: [],
  }
  if (!body || typeof body !== 'object') return failure
  const envelope = (body as { error?: unknown }).error
  const details: string[] = []
  if (envelope && typeof envelope === 'object') {
    const inner = envelope as Record<string, unknown>
    failure.code = asString(inner.code)
    failure.requestId = asString(inner.requestId)
    const extra = inner.details && typeof inner.details === 'object'
      ? (inner.details as Record<string, unknown>)
      : null
    if (extra) {
      failure.importId = asString(extra.importId)
      // details.reason is the raw thrown message a fallback code wrapped. It
      // is shown only when it is a user-facing Swedish sentence the registry
      // text replaced; a stack-shaped or English reason stays in the logs,
      // reachable through the reference line.
      const reason = asString(extra.reason)
      if (reason && looksLikeUserFacingSwedish(reason)) details.push(reason)
      // VALIDATION_ERROR issues are already rendered into the sentence by
      // getErrorMessage (per source account, with the mapping-step advice);
      // listing them again would say the same thing in other words.
      details.push(
        ...stringList(extra.errors),
        ...(failure.code === 'VALIDATION_ERROR' ? [] : stringList(extra.issues)),
        ...unmappedList(extra.unmappedAccounts),
      )
    }
  } else if (typeof envelope === 'string') {
    const legacy = body as Record<string, unknown>
    failure.code = asString(envelope)
    const message = asString(legacy.message)
    if (message && looksLikeUserFacingSwedish(message)) failure.message = message
    details.push(...unmappedList(legacy.unmappedAccounts))
  }
  failure.details = settleDetails(details, failure.message)
  return failure
}

/**
 * Describe a job row that ended in failed or paused (or carries an
 * error_message in any state). The worker records the thrown reason on the
 * row; the finished result may carry per-voucher errors as well.
 */
export function describeSIEJobFailure(
  job: Pick<SIEJob, 'id' | 'job_state' | 'error_message' | 'job_result'>,
): ImportFailure {
  const own = asString(job.error_message)
  const message = own
    ?? (job.job_state === 'paused'
      ? 'Importen behöver granskas.'
      : job.job_state === 'undone'
        ? 'Importen är ångrad.'
        : 'Importen misslyckades utan felmeddelande.')
  const errors = stringList((job.job_result as { errors?: unknown } | null)?.errors)
  return {
    message,
    code: null,
    requestId: null,
    importId: job.id,
    details: settleDetails(errors, message),
  }
}

/** "Referens: kod X, ärende Y, import Z", or null when nothing is known. */
export function formatImportFailureReference(failure: ImportFailure): string | null {
  const parts: string[] = []
  if (failure.code) parts.push(`kod ${failure.code}`)
  if (failure.requestId) parts.push(`ärende ${failure.requestId}`)
  if (failure.importId) parts.push(`import ${failure.importId}`)
  return parts.length ? `Referens: ${parts.join(', ')}` : null
}

/**
 * One multi-line string for surfaces that show a single text (the migration
 * wizard's result step, the SIE wizard's review step): the sentence, one
 * bullet per detail, the reference last. Render with whitespace-pre-line.
 */
export function formatImportFailure(failure: ImportFailure): string {
  const lines = [failure.message, ...failure.details.map((line) => `• ${line}`)]
  const reference = formatImportFailureReference(failure)
  if (reference) lines.push(reference)
  return lines.join('\n')
}
