import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getAiStatus } from '@/lib/ai'
import { extensionRegistry } from '@/lib/extensions/registry'
import { createServiceClient } from '@/lib/supabase/server'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { readUnderlagFacts } from '@/lib/transactions/underlag-read'

// GET /api/documents/:id/extraction-status
//
// Light-weight polling endpoint for the AI document-extraction pipeline.
// Returns the minimal fields needed to drive an "extracting…" UI without
// touching storage (no signed URL creation per poll). Once the extraction
// has succeeded it also returns the facts a booking needs off it (supplier,
// totals, moms and its rate), so a review that just took an upload can book
// the document's moms without another round trip.
//
// Derived status:
//   running     : extracted_at IS NULL and this deployment has AI configured
//                 (the pipeline hasn't stamped yet)
//   succeeded   : extracted_at IS NOT NULL AND extracted_data IS NOT NULL
//   disabled    : no extraction will ever happen for this document and that
//                 is not the document's fault: AI is not configured on this
//                 deployment (extracted_at NULL + unconfigured, or stamped
//                 skipped:ai_unconfigured), the company is not entitled to
//                 AI extraction (skipped:no_ai_entitlement), a sandbox or
//                 client opt-out, or a document the system generated itself
//                 (skipped:system_generated). The UI shows nothing.
//   unsupported : any other skipped:* (HEIC, ZIP, no vision model, …)
//   failed      : extracted_at IS NOT NULL AND extracted_data IS NULL AND
//                 extraction_model = 'failed:*'
//
// A reading that never stamped: the upload answers before the document is
// read (the reading runs after the response), so a function that is frozen
// or killed mid-reading leaves extracted_at NULL for good, and this route
// answered "running" for that document on every later visit. A reading still
// open ten minutes after the upload (a reading ends itself at 250 s) is taken
// as interrupted: stamped failed:abandoned, reported once, answered "failed".
// A later reading (the inbox's "read again") overwrites the stamp.
//
// Before extraction was stamped on every outcome, free-tier uploads and
// unconfigured self-hosts left the column NULL forever and the client had to
// decide "disabled" by timing out after 30 s. It still keeps that timeout as
// the last resort (the document-extraction extension may be switched off).
export type DocumentExtractionStatus = 'running' | 'succeeded' | 'failed' | 'unsupported' | 'disabled'

const QUIET_SKIPS = new Set([
  'skipped:ai_unconfigured',
  'skipped:no_ai_entitlement',
  'skipped:sandbox',
  'skipped:client_opt_out',
  'skipped:system_generated',
])

export function deriveExtractionStatus(row: {
  extracted_at: string | null
  extracted_data: unknown
  extraction_model: string | null
}, aiConfigured: boolean): DocumentExtractionStatus {
  if (!row.extracted_at) return aiConfigured ? 'running' : 'disabled'
  if (row.extracted_data) return 'succeeded'
  const model = row.extraction_model ?? ''
  if (QUIET_SKIPS.has(model)) return 'disabled'
  if (model.startsWith('skipped:')) return 'unsupported'
  return 'failed'
}

/** The stamp of a reading that was still open long after its upload: the function reading it died. */
export const ABANDONED_STAMP = 'failed:abandoned'
/** Far past the longest reading (250 s, EXTRACTION_DEADLINE_MS) and the 300 s the function running it lives. */
const ABANDONED_AFTER_MS = 10 * 60_000
/**
 * Only an upload this recent is reported: someone is at the screen, and the
 * reading can still be looked into. An old row that never got a stamp (from
 * before every outcome was stamped, or an inbox item that was never read) is
 * settled the same way, without an alert nobody can act on.
 */
const REPORT_WITHIN_MS = 24 * 60 * 60_000

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.extraction_status',
  async (_request, { supabase, companyId, log }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, created_at, extracted_at, extracted_data, extraction_model')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const row = {
      extracted_at: data.extracted_at as string | null,
      extracted_data: data.extracted_data as Record<string, unknown> | null,
      extraction_model: data.extraction_model as string | null,
    }
    let status = deriveExtractionStatus(row, getAiStatus().configured)

    const ageMs = Date.now() - new Date(data.created_at as string).getTime()
    if (status === 'running' && ageMs > ABANDONED_AFTER_MS) {
      if (!(await extensionRegistry.get('document-extraction'))) {
        // Nothing reads uploads on this deployment (the extension is off): not a reading that failed.
        status = 'disabled'
      } else {
        status = 'failed'
        row.extracted_at = new Date().toISOString()
        row.extraction_model = ABANDONED_STAMP
        // Service role, like every other stamp of these columns: a system note, not the member's edit. Only a
        // row still unstamped is written, so a reading that lands at this moment wins and the report is made once.
        const { data: stamped, error: stampError } = await createServiceClient()
          .from('document_attachments')
          .update({ extracted_at: row.extracted_at, extraction_model: ABANDONED_STAMP })
          .eq('id', id)
          .eq('company_id', companyId)
          .is('extracted_at', null)
          .select('id')
        const fields = { doc: id, companyId, uploadedMinutesAgo: Math.round(ageMs / 60_000) }
        if (stampError) log.warn('abandoned reading not stamped', { ...fields, reason: stampError.message })
        else if ((stamped ?? []).length > 0) {
          if (ageMs <= REPORT_WITHIN_MS) log.error('document reading was interrupted and never finished, stamped failed:abandoned', fields)
          else log.info('old document without a reading stamped failed:abandoned', fields)
        } else {
          // Nothing was written: the row got its stamp between the read above and the write, from a reading that
          // landed just now or from another poll. The answer is what the row says now, not the verdict that lost:
          // the screen takes "failed" as final and would never show the reading that did arrive.
          const { data: fresh, error: freshError } = await supabase
            .from('document_attachments')
            .select('id, extracted_at, extracted_data, extraction_model')
            .eq('id', id)
            .eq('company_id', companyId)
            .maybeSingle()
          if (freshError) log.warn('abandoned reading: row not read again', { ...fields, reason: freshError.message })
          else if (fresh?.extracted_at) {
            row.extracted_at = fresh.extracted_at as string
            row.extracted_data = fresh.extracted_data as Record<string, unknown> | null
            row.extraction_model = fresh.extraction_model as string | null
            status = deriveExtractionStatus(row, true)
          }
        }
      }
    }

    return NextResponse.json({
      data: {
        id: data.id,
        status,
        extracted_at: row.extracted_at,
        extraction_model: row.extraction_model,
        facts: status === 'succeeded' ? readUnderlagFacts(row.extracted_data) : null,
      },
    })
  }
)
