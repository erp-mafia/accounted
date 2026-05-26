import type { Extension } from '@/lib/extensions/types'
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractInvoiceFields } from '@/extensions/general/invoice-inbox/lib/extract-invoice-fields'
import { createLogger } from '@/lib/logger'
import { createServiceClient } from '@/lib/supabase/server'
import type { DocumentAttachment } from '@/types'

const log = createLogger('document-extraction')

// Mime types we know Claude can read directly via Bedrock. Anything else
// (HEIC, ZIP, TXT, …) is skipped — extracted_at still gets stamped so the
// row is marked as "attempted, not eligible".
const SUPPORTED_MIME_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
])

// AI-extraction extension — paid AI tier only.
//
// Subscribes to the existing document.uploaded event bus topic and runs
// Sonnet 4.6 (via Bedrock, reusing invoice-inbox's extractInvoiceFields) on
// every uploaded receipt or invoice. Writes the result to
// document_attachments.extracted_data so the agent intent capture can use
// it without re-asking the user.
//
// Idempotency: skips when extracted_at is already set on the row. Also
// dedupes against invoice_inbox_items.extracted_data — when the inbox
// extension already extracted the same file, we copy its result instead
// of paying for a second Sonnet call.
//
// Free tier: disable this extension in extensions.config.json. Uploads
// still work; the agent intent will see null extracted_data and either
// ask the user or call gnubok_get_document_content at chat-time.
//
// See dev_docs/specialized-agent-plan.md (§ paid/free tier note) — to be
// authored.
export const documentExtractionExtension: Extension = {
  id: 'document-extraction',
  name: 'AI document extraction',
  version: '1.0.0',

  eventHandlers: [
    {
      eventType: 'document.uploaded',
      handler: async (payload) => {
        const { document, companyId } = payload as {
          document: DocumentAttachment
          userId: string
          companyId: string
        }
        await extractAndPersist(document, companyId)
      },
    },
  ],
}

async function extractAndPersist(
  document: DocumentAttachment,
  companyId: string,
): Promise<void> {
  // Service-role client: the handler runs out-of-band of the request that
  // emitted the event, so we don't have user cookies. RLS doesn't fit —
  // events have no user context.
  const supabase: SupabaseClient = createServiceClient()

  // Idempotency guard: never re-extract a row that already has extracted_at.
  // Note: the column may be null OR the row may not yet have the new
  // schema (legacy supabase types). Fail closed on missing schema.
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

  // Dedup against inbox: if invoice-inbox already extracted this exact file
  // (same document_id), copy its result to avoid a second AI call. If the
  // inbox row marked the upload as skip_extraction=true, the inbox row's
  // extracted_data is an empty skeleton — we must stamp the doc with a
  // 'skipped:*' model so the client-side useDocumentExtraction hook reports
  // 'unsupported' rather than 'succeeded' (otherwise the UI would claim AI
  // finished reading a doc it never opened).
  const { data: inboxRow } = await supabase
    .from('invoice_inbox_items')
    .select('extracted_data, extraction_skipped')
    .eq('document_id', document.id)
    .maybeSingle()

  if (inboxRow?.extraction_skipped) {
    await supabase
      .from('document_attachments')
      .update({
        extracted_at: new Date().toISOString(),
        extraction_model: 'skipped:invoice_inbox_gate',
      })
      .eq('id', document.id)
    return
  }

  let extractedData: Record<string, unknown> | null = null
  let model: string = 'copied-from-invoice-inbox'

  if (inboxRow?.extracted_data) {
    extractedData = inboxRow.extracted_data as Record<string, unknown>
  } else {
    const mimeType = existing.mime_type as string | null
    if (!mimeType || !SUPPORTED_MIME_TYPES.has(mimeType)) {
      // Stamp the attempt so we don't keep retrying unsupported types.
      await supabase
        .from('document_attachments')
        .update({ extracted_at: new Date().toISOString(), extraction_model: 'skipped:unsupported_mime' })
        .eq('id', document.id)
      return
    }

    // Download the file from Supabase Storage. The bucket is private — the
    // service-role client can read any path.
    const storagePath = existing.storage_path as string | null
    if (!storagePath) {
      log.warn('document has no storage_path, skipping', { doc: document.id })
      return
    }

    const { data: blob, error: dlErr } = await supabase.storage
      .from('documents')
      .download(storagePath)
    if (dlErr || !blob) {
      log.warn('storage download failed', { doc: document.id, err: dlErr?.message })
      return
    }
    const buffer = Buffer.from(await blob.arrayBuffer())

    try {
      const { data, rawText } = await extractInvoiceFields({
        buffer,
        mimeType,
        fileName: (document.file_name as string) || 'document',
      })
      // extractInvoiceFields returns an "empty" result on failure rather
      // than throwing — distinguish by checking rawText. When rawText is
      // null, the call was skipped (creds missing, unsupported type) or
      // the JSON parse failed.
      if (!rawText) {
        await supabase
          .from('document_attachments')
          .update({
            extracted_at: new Date().toISOString(),
            extraction_model: 'failed:no_raw_text',
          })
          .eq('id', document.id)
        return
      }
      extractedData = data as unknown as Record<string, unknown>
      model = process.env.BEDROCK_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6'
    } catch (err) {
      log.warn('extraction threw', {
        doc: document.id,
        err: err instanceof Error ? err.message : String(err),
      })
      await supabase
        .from('document_attachments')
        .update({
          extracted_at: new Date().toISOString(),
          extraction_model: 'failed:exception',
        })
        .eq('id', document.id)
      return
    }
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
