import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { isPeriodLockRefusal } from './locked-period'
import { modelReadingToKeep, type DocumentReadingRow } from './model-reading'

const log = createLogger('document-reading-correction')

export type CorrectionMirrorOutcome = 'mirrored' | 'no_document' | 'locked' | 'failed'

/**
 * Mirror a corrected reading of an inbox item (a person's field edit, an
 * agent's gnubok_set_inbox_extracted_data) onto its document's
 * extracted_data, so every reader of the document row (Arkiv's get_record,
 * the classifier's inbox kind, the agent intents) sees the correction and not
 * the model's value it replaced.
 *
 * The model's own reading is copied to model_reading first, once
 * (modelReadingToKeep): the suggestion log pairs what the model read with
 * what was booked, and extracted_data no longer holds it after this write.
 * extracted_at and extraction_model are left as the model stamped them.
 *
 * Same service-role client as the extraction mirror, and the same rule: never
 * throws, so it cannot fail the edit, which has already landed on the item. A
 * document whose verifikat sits in a closed or locked period is refused by
 * enforce_period_lock_documents (every update of such a row, not only the
 * link): that is skipped and logged, and the item keeps the correction.
 */
export async function mirrorCorrectedReadingToDocument(input: {
  documentId: string | null | undefined
  companyId: string
  reading: Record<string, unknown>
}): Promise<CorrectionMirrorOutcome> {
  const { documentId, companyId, reading } = input
  if (!documentId) return 'no_document'
  try {
    const supabase = createServiceClientNoCookies()
    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, extracted_data, extracted_at, extraction_model, model_reading')
      .eq('id', documentId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) {
      log.warn('correction mirror: document read failed', { doc: documentId, err: error.message })
      return 'failed'
    }
    if (!data) return 'no_document'
    const keep = modelReadingToKeep(data as DocumentReadingRow)
    // Two literal payloads, not a spread: the phantom-column guard checks literal keys only.
    const { error: updateError } = keep
      ? await supabase
          .from('document_attachments')
          .update({ extracted_data: reading, model_reading: keep })
          .eq('id', documentId)
          .eq('company_id', companyId)
      : await supabase
          .from('document_attachments')
          .update({ extracted_data: reading })
          .eq('id', documentId)
          .eq('company_id', companyId)
    if (updateError) {
      if (isPeriodLockRefusal(updateError)) {
        log.info('correction mirror skipped: the document sits in a locked period', { doc: documentId })
        return 'locked'
      }
      log.warn('correction mirror failed', { doc: documentId, err: updateError.message })
      return 'failed'
    }
    return 'mirrored'
  } catch (err) {
    log.warn('correction mirror threw', {
      doc: documentId,
      err: err instanceof Error ? err.message : String(err),
    })
    return 'failed'
  }
}
