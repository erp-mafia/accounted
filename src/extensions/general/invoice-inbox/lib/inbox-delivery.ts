import type { FileInboxDelivery } from '@/lib/intake/partner-delivery'
import { uploadAndExtract } from './upload-and-extract'

/**
 * File a delivered document into the Inkorg through the same pipeline as the
 * person's upload (content dedupe, extraction, Arkiv): inbox source
 * 'upload', staged extraction, the door's provenance in channel_context.
 * Registered as the extension's `fileInboxDelivery` service for the v1
 * partner door (contract: src/lib/intake/partner-delivery.ts). Files only:
 * no supplier invoice, no verifikat.
 */
export const fileInboxDelivery: FileInboxDelivery = async (supabase, input) => {
  const result = await uploadAndExtract(
    supabase,
    input.userId,
    input.companyId,
    input.file,
    'upload',
    {
      from: input.senderName ?? null,
      subject: input.subject ?? null,
      receivedAt: input.receivedAt ?? null,
      // The sender's declared kind, with the +lev / +ver tag's semantics: it
      // also reclassifies an unconsumed item the same content already filed.
      kindHint: input.kindHint ?? null,
    },
    null,
    // The response carries ids only, so it never waits on the model call.
    { deferExtraction: true, channelContext: input.channelContext },
  )
  return {
    document_id: result.document_id,
    inbox_item_id: result.inbox_item_id,
    deduplicated: 'duplicate' in result && result.duplicate === true,
  }
}
