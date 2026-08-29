import type { Extension } from '@/lib/extensions/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { getAiStatus } from '@/lib/ai'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import type { DocumentAttachment } from '@/types'
import type { DocumentExtractionOwner } from '@/lib/events/types'

const log = createLogger('document-extraction')

// Mime types the extraction can read (a vision model reads PDFs natively on
// Claude; OpenAI-compatible backends rasterize them). Anything else (HEIC,
// ZIP, TXT, bank JSON, …) is skipped: extracted_at still gets stamped so the
// row is marked as "attempted, not eligible".
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

// AI-extraction extension: paid AI tier only.
//
// Subscribes to the existing document.uploaded event bus topic and runs the
// configured extraction model (reusing invoice-inbox's extractInvoiceFields)
// on every uploaded receipt or invoice. Writes the result to
// document_attachments.extracted_data so the agent intent capture can use
// it without re-asking the user.
//
// Idempotency: skips when extracted_at is already set on the row.
//
// Ownership: documents that enter through the invoice inbox (web upload,
// email, WhatsApp, MCP upload) are extracted by the inbox itself, which
// mirrors its result onto document_attachments when done. The inbox marks
// the upload with `extractionOwner: 'invoice-inbox'` on the event payload
// and this handler yields. It used to race instead: the inbox row did not
// exist yet when this handler ran inside uploadDocument(), so every inbox
// document was extracted twice (two paid model calls per receipt).
//
// Every outcome that means "no extraction will ever happen here" is stamped
// as `skipped:<reason>` so the polling UI stops immediately instead of
// timing out: paywall (`no_ai_entitlement`), no AI configured on this
// deployment (`ai_unconfigured`), self-generated documents (our own invoice
// PDFs, payout files: `system_generated`), unsupported types.
//
// Free tier: disable this extension in extensions.config.json. Uploads
// still work; the agent intent will see null extracted_data and either
// ask the user or call gnubok_get_document_content at chat-time.
export const documentExtractionExtension: Extension = {
  id: 'document-extraction',
  name: 'AI document extraction',
  version: '1.1.0',

  eventHandlers: [
    {
      eventType: 'document.uploaded',
      handler: async (payload) => {
        const { document, companyId, extractionOwner } = payload as {
          document: DocumentAttachment
          userId: string
          companyId: string
          extractionOwner?: DocumentExtractionOwner
        }
        if (extractionOwner === 'invoice-inbox') return
        if (extractionOwner === 'none') {
          // The uploader already holds the booking (provider underlag import
          // links each file to its posted verifikat): a model pass would cost
          // a paid call per file and, run inline, blew the 300 s route budget
          // on a 113-file Fortnox import (2026-08-21). Stamp so nothing polls.
          await stamp(createServiceClient(), document.id, 'skipped:opted_out')
          return
        }
        await extractAndPersist(document, companyId)
      },
    },
  ],
}

async function stamp(
  supabase: SupabaseClient,
  documentId: string,
  extractionModel: string
): Promise<void> {
  const { error } = await supabase
    .from('document_attachments')
    .update({ extracted_at: new Date().toISOString(), extraction_model: extractionModel })
    .eq('id', documentId)
  if (error) log.warn('stamp failed', { doc: documentId, extractionModel, err: error.message })
}

async function extractAndPersist(
  document: DocumentAttachment,
  companyId: string,
): Promise<void> {
  // Service-role client: the handler runs out-of-band of the request that
  // emitted the event, so we don't have user cookies. RLS doesn't fit:
  // events have no user context.
  const supabase: SupabaseClient = createServiceClient()

  // Cheap gates first, straight from the event payload: no DB round trip for
  // the thousands of bank-statement JSON documents a sync produces.
  const mimeType = (document.mime_type as string | null) ?? null
  if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
    await stamp(supabase, document.id, 'skipped:unsupported_mime')
    return
  }
  // Documents the system produced itself (our own invoice PDFs, payment
  // files, filings) carry nothing to extract; reading them back with a paid
  // model is waste, on hosted and doubly so on a BYO-key self-host.
  if (document.upload_source === 'system') {
    await stamp(supabase, document.id, 'skipped:system_generated')
    return
  }

  // Idempotency guard: never re-extract a row that already has extracted_at.
  const { data: existing, error: existingErr } = await supabase
    .from('document_attachments')
    .select('id, mime_type, storage_path, extracted_at')
    .eq('id', document.id)
    .single()
  if (existingErr || !existing) {
    log.warn('document not found, skipping extraction', {
      doc: document.id,
      err: existingErr?.message,
    })
    return
  }
  if (existing.extracted_at) {
    return
  }

  // No AI configured on this deployment: stamp and stop. This is the
  // self-host "key not set yet" state; the status route reports it as
  // disabled on the first poll instead of after a 30 s timeout.
  if (!getAiStatus().configured) {
    await stamp(supabase, document.id, 'skipped:ai_unconfigured')
    return
  }

  // Paywall: the free/manual tier never triggers paid extraction. Stamp it so
  // the row reads "attempted, not entitled" rather than NULL forever (which
  // the polling UI could only interpret by timing out).
  if (!(await hasCapability(supabase, companyId, CAPABILITY.ai))) {
    log.info('extraction skipped, ai capability not entitled', { doc: document.id, companyId })
    await stamp(supabase, document.id, 'skipped:no_ai_entitlement')
    return
  }

  // Download the file from Supabase Storage. The bucket is private: the
  // service-role client can read any path.
  const storagePath = existing.storage_path as string | null
  if (!storagePath) {
    log.warn('document has no storage_path, skipping', { doc: document.id })
    await stamp(supabase, document.id, 'failed:no_storage_path')
    return
  }

  const { data: blob, error: dlErr } = await supabase.storage
    .from('documents')
    .download(storagePath)
  if (dlErr || !blob) {
    log.warn('storage download failed', { doc: document.id, err: dlErr?.message })
    await stamp(supabase, document.id, 'failed:storage_download')
    return
  }
  const buffer = Buffer.from(await blob.arrayBuffer())

  let extractedData: Record<string, unknown> | null = null
  let model: string
  try {
    const { data, rawText, model: usedModel, skipped } = await extractInvoiceFields({
      buffer,
      mimeType,
      fileName: (document.file_name as string) || 'document',
    })
    // extractInvoiceFields returns an "empty" result on failure rather than
    // throwing. `skipped` means no model call was made (and why); a null
    // rawText with no skip means the call failed or the JSON parse did.
    if (skipped) {
      await stamp(supabase, document.id, `skipped:${skipped}`)
      return
    }
    if (!rawText) {
      await stamp(supabase, document.id, 'failed:no_raw_text')
      return
    }
    extractedData = data as unknown as Record<string, unknown>
    model = usedModel ?? 'unknown'
  } catch (err) {
    log.warn('extraction threw', {
      doc: document.id,
      err: err instanceof Error ? err.message : String(err),
    })
    await stamp(supabase, document.id, 'failed:exception')
    return
  }

  const { error: updateErr } = await supabase
    .from('document_attachments')
    .update({
      extracted_data: extractedData,
      extracted_at: new Date().toISOString(),
      extraction_model: model,
    })
    .eq('id', document.id)
  if (updateErr) {
    log.warn('persist failed', { doc: document.id, err: updateErr.message, companyId })
    return
  }
  log.info('extraction persisted', { doc: document.id, model, companyId })
}
