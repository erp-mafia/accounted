import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

// GET /api/documents/:id/extraction-status
//
// Light-weight polling endpoint for the AI document-extraction pipeline.
// Returns the minimal fields needed to drive an "extracting…" UI without
// touching storage (no signed URL creation per poll).
//
// Derived status:
//   running     : extracted_at IS NULL (pipeline hasn't stamped yet)
//   succeeded   : extracted_at IS NOT NULL AND extracted_data IS NOT NULL
//   unsupported : extraction_model = 'skipped:*' (HEIC, ZIP, …)
//   failed      : extracted_at IS NOT NULL AND extracted_data IS NULL AND
//                 extraction_model = 'failed:*'
//   disabled    : the document-extraction extension isn't enabled (column
//                 stays untouched indefinitely). Client times out and shows
//                 a quiet fallback. We don't distinguish this from running
//                 server-side: the client decides based on elapsed time.
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

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

    const extractedAt = data.extracted_at as string | null
    const extractedData = data.extracted_data as Record<string, unknown> | null
    const model = data.extraction_model as string | null

    let status: 'running' | 'succeeded' | 'failed' | 'unsupported'
    if (!extractedAt) {
      status = 'running'
    } else if (extractedData) {
      status = 'succeeded'
    } else if (model?.startsWith('skipped:')) {
      status = 'unsupported'
    } else {
      status = 'failed'
    }

    return NextResponse.json({
      data: {
        id: data.id,
        status,
        extracted_at: extractedAt,
        extraction_model: model,
      },
    })
  }
)
