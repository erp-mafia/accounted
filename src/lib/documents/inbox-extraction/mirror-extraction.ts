import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type { InvoiceExtractionResult } from '@/types'
import type { ExtractionFailure } from './extraction-failure'

const log = createLogger('invoice-inbox-mirror')

export interface ExtractionOutcome {
  /** The parsed result (may be the empty skeleton). Ignored unless `rawText` is set and nothing was skipped. */
  data: InvoiceExtractionResult | null
  /** Raw model output; null when the call failed or was skipped. */
  rawText: string | null
  /** Provider-form model id that answered, when a call was made. */
  model?: string | null
  /** Why no model call was made: inbox skip reasons and lib/ai skip reasons alike. */
  skipped?: string | null
  /** Why a call that was made failed (extractInvoiceFields' `failure`). */
  failure?: ExtractionFailure | null
  /**
   * Which reading of this document a provider_unavailable failure was: 1 for
   * the upload's, 2 and up for the inbox sweep's retries. Recorded in the
   * stamp so the retry can be capped without a column of its own.
   */
  attempt?: number
}

/**
 * The stamp of a reading the AI provider could not take. Distinct from
 * failed:no_raw_text (every other failed call), so an outage is never read as
 * an unreadable document and only these are retried by the inbox sweep. The
 * first reading carries no number; a retry appends its attempt
 * (failed:provider_unavailable:2). Every reader that treats `failed:*` as "a
 * reading that never happened" (isModelExtraction, the extraction-status
 * poll, the suggestion log) reads these the same way.
 */
export const PROVIDER_UNAVAILABLE_STAMP = 'failed:provider_unavailable'

export function providerUnavailableStamp(attempt: number): string {
  return attempt <= 1 ? PROVIDER_UNAVAILABLE_STAMP : `${PROVIDER_UNAVAILABLE_STAMP}:${attempt}`
}

/** The attempt a provider_unavailable stamp records, or null for any other stamp. */
export function providerUnavailableAttempt(stamp: string | null | undefined): number | null {
  if (stamp === PROVIDER_UNAVAILABLE_STAMP) return 1
  const match = /^failed:provider_unavailable:(\d+)$/.exec(stamp ?? '')
  return match ? Number(match[1]) : null
}

/** Whether the outcome is a reading: the model answered and nothing was skipped. */
export function isReadOutcome(outcome: ExtractionOutcome): boolean {
  return !outcome.skipped && outcome.rawText != null && outcome.data != null
}

/** The extraction_model stamp for an outcome. Pure. */
export function extractionStamp(outcome: ExtractionOutcome): string {
  if (outcome.skipped) return `skipped:${outcome.skipped}`
  if (isReadOutcome(outcome)) return outcome.model || 'invoice-inbox'
  if (outcome.failure === 'provider_unavailable') return providerUnavailableStamp(outcome.attempt ?? 1)
  return 'failed:no_raw_text'
}

/**
 * Mirror an inbox extraction outcome onto document_attachments
 * (extracted_data / extracted_at / extraction_model).
 *
 * The invoice inbox owns extraction for the documents it ingests, and the
 * document-extraction extension yields to it (see extractionOwner on the
 * document.uploaded event). Everything that read the document row before
 * (the extraction-status poll behind the upload UI, the agent intents'
 * "what do we already know" reads) keeps working because the inbox writes
 * the same columns the extension would have, with the one model call it
 * actually made.
 *
 * Service-role client, same as the extension: this runs from routes, the
 * deferred worker and the MCP server alike, and the write is a system
 * side-effect rather than a user action. Never throws: a failed mirror
 * leaves the document row unstamped, which the UI already tolerates.
 */
export async function mirrorExtractionToDocument(
  documentId: string,
  outcome: ExtractionOutcome
): Promise<void> {
  try {
    const succeeded = isReadOutcome(outcome)
    const extractionModel = extractionStamp(outcome)
    const supabase = createServiceClientNoCookies()
    const { error } = await supabase
      .from('document_attachments')
      .update({
        extracted_data: succeeded ? (outcome.data as unknown as Record<string, unknown>) : null,
        extracted_at: new Date().toISOString(),
        extraction_model: extractionModel,
      })
      .eq('id', documentId)
    if (error) {
      log.warn('mirror failed', { doc: documentId, extractionModel, err: error.message })
    }
  } catch (err) {
    log.warn('mirror threw', {
      doc: documentId,
      err: err instanceof Error ? err.message : String(err),
    })
  }
}
