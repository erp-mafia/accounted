import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'

export const GET = withRouteContext(
  'invoice.peek_next_number',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const documentType = url.searchParams.get('document_type') ?? 'invoice'
    if (!['invoice', 'proforma', 'delivery_note', 'quote'].includes(documentType)) {
      return NextResponse.json(
        { error: 'invalid document_type', requestId },
        { status: 400 },
      )
    }

    // delivery_note has its own sequence (generate_delivery_note_number); the
    // peek RPC only covers the invoice/proforma F-series counter, so for
    // delivery notes we return null and let the form skip the preview.
    if (documentType === 'delivery_note') {
      return NextResponse.json({ data: { preview: null } })
    }

    const { data, error } = await supabase.rpc('peek_next_invoice_number', {
      p_company_id: companyId,
      p_document_type: documentType,
    })

    if (error) {
      log.error('peek_next_invoice_number failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({ data: { preview: data ?? null } })
  },
)
