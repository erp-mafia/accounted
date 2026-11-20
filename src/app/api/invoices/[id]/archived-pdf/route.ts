import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { contentDisposition } from '@/lib/api/content-disposition'
import { PRIVATE_NO_STORE_HEADERS } from '@/lib/api/private-no-store'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isInvoicerRole } from '@/lib/auth/invoicer-role'
import { loadArchivedInvoicePdf } from '@/lib/invoices/archived-invoice-pdf'

/**
 * GET /api/invoices/[id]/archived-pdf
 *
 * The invoice PDF as it was sent: the archived file of one delivery of THIS
 * invoice, byte for byte (loadArchivedInvoicePdf checks it against its stored
 * SHA-256). `?delivery=<id>` names the delivery; without it, the latest
 * completed email delivery, the file the download button serves.
 *
 * The path the invoicing-only role reads a sent invoice through (for #206):
 * the role never reaches /api/documents, which opens any document of the
 * company (underlag, payroll, bank). This route opens nothing but a file an
 * invoice delivery of the named invoice points at, so it stays inside the
 * invoicing area. Other roles keep /api/documents/[id]/inline and may use
 * this one too.
 *
 * For the role the handler runs on the company-scoped service client
 * (INVOICER_ROUTES, `scoped`), where auth.uid() is null: the delivery
 * history is then read for the signed-in member by name, as the reminder
 * sender reads it.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.archived_pdf',
  async (request, { supabase, companyId, user, role, log, requestId }, { params }) => {
    const { id } = await params
    const delivery = new URL(request.url).searchParams.get('delivery')
    if (!z.string().uuid().safeParse(id).success || (delivery !== null && !z.string().uuid().safeParse(delivery).success)) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { field: delivery === null ? 'id' : 'delivery', message: 'Must be a UUID.' },
      })
    }

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (invoiceError || !invoice) {
      return errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId })
    }

    const archived = await loadArchivedInvoicePdf(supabase, companyId, id, log, {
      ...(delivery ? { deliveryId: delivery } : {}),
      ...(isInvoicerRole(role) ? { serviceActorUserId: user.id } : {}),
    })
    if (!archived.ok) {
      if (archived.code === 'INVOICE_RESEND_NO_ARCHIVED_COPY') {
        return errorResponseFromCode('NOT_FOUND', log, {
          requestId,
          messageSv: 'Det finns ingen sparad kopia av fakturan för det här utskicket.',
          messageEn: 'There is no saved copy of the invoice for this delivery.',
        })
      }
      return errorResponseFromCode('INVOICE_RESEND_ARCHIVE_UNAVAILABLE', log, {
        requestId,
        messageSv: 'Den sparade kopian av fakturan kunde inte läsas. Försök igen om en stund.',
        messageEn: 'The saved copy of the invoice could not be read. Try again shortly.',
      })
    }

    return new NextResponse(archived.value.bytes, {
      status: 200,
      headers: {
        // Always a PDF: the archive holds the rendered invoice, never an upload.
        'Content-Type': 'application/pdf',
        'Content-Disposition': contentDisposition('inline', archived.value.filename),
        'X-Content-Type-Options': 'nosniff',
        ...PRIVATE_NO_STORE_HEADERS,
      },
    })
  },
)
