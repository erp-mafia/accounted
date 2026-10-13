import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import type { InvoiceExtractionResult } from '@/types'

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
    const succeeded = !outcome.skipped && outcome.rawText != null && outcome.data != null
    const extractionModel = outcome.skipped
      ? `skipped:${outcome.skipped}`
      : succeeded
        ? outcome.model || 'invoice-inbox'
        : 'failed:no_raw_text'
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
