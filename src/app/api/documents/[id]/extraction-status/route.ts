import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getAiStatus } from '@/lib/ai'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// GET /api/documents/:id/extraction-status
//
// Light-weight polling endpoint for the AI document-extraction pipeline.
// Returns the minimal fields needed to drive an "extracting…" UI without
// touching storage (no signed URL creation per poll).
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

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'document.extraction_status',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('document_attachments')
      .select('id, extracted_at, extracted_data, extraction_model')
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
    const status = deriveExtractionStatus(row, getAiStatus().configured)

    return NextResponse.json({
      data: {
        id: data.id,
        status,
        extracted_at: row.extracted_at,
        extraction_model: row.extraction_model,
      },
    })
  }
)
