import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { LinkInvoiceAttachmentsSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { linkInvoiceAttachments, listInvoiceAttachments } from '@/lib/invoices/invoice-attachments'

/**
 * Files emailed with an invoice after its PDF (crm#1269).
 *
 * GET lists them; POST attaches documents already in the archive (the send
 * dialog uploads through POST /api/documents first, then attaches the id).
 * Attachments change only on a draft that has never been emailed: afterwards
 * they are part of what the customer received (lib/invoices/invoice-attachments).
 */

function invalidInvoiceId(id: string) {
  return !z.string().uuid().safeParse(id).success
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.attachments.list',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (invalidInvoiceId(id)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }

    const { data: invoice, error } = await supabase
      .from('invoices')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error || !invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }

    const attachments = await listInvoiceAttachments(supabase, companyId!, id)
    return NextResponse.json({ data: attachments })
  },
)

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.attachments.link',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    if (invalidInvoiceId(id)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: 'id', message: 'Invoice id must be a UUID.' },
      })
    }

    const validation = await validateBody(request, LinkInvoiceAttachmentsSchema, { log, operation: 'invoice.attachments.link' })
    if (!validation.success) return validation.response

    const result = await linkInvoiceAttachments(supabase, companyId!, id, validation.data.document_ids)
    if (!result.ok) {
      return errorResponseFromCode(result.code, log, { requestId })
    }
    return NextResponse.json({ data: result.value })
  },
  { requireWrite: true },
)
