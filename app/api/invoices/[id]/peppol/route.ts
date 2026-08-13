import { NextResponse } from 'next/server'
import { z } from 'zod'
import { contentDisposition } from '@/lib/api/content-disposition'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { generatePeppolBisBillingInvoice } from '@/lib/invoices/peppol-bis-billing'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

const paramsSchema = z.object({ id: z.uuid() })

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.peppol',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsedParams = paramsSchema.safeParse(await params)
    if (!parsedParams.success) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { fields: parsedParams.error.flatten().fieldErrors },
      }))
    }
    const { id } = parsedParams.data

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select(`
        *,
        customer:customers(*),
        items:invoice_items(*)
      `)
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (invoiceError || !invoice) {
      return privateNoStore(errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId }))
    }

    const { data: company, error: companyError } = await supabase
      .from('company_settings')
      .select('*')
      .eq('company_id', companyId)
      .single()

    if (companyError || !company) {
      return privateNoStore(errorResponseFromCode(
        'INVOICE_SEND_COMPANY_SETTINGS_MISSING',
        log,
        { requestId },
      ))
    }

    const typedInvoice = invoice as Invoice & { customer?: Customer; items?: InvoiceItem[] }
    if (!typedInvoice.customer) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Fakturan saknar en kund som kan användas för Peppol-export.',
        messageEn: 'The invoice has no customer available for Peppol export.',
        details: { field: 'invoice.customer' },
      }))
    }

    const result = generatePeppolBisBillingInvoice({
      invoice: typedInvoice,
      customer: typedInvoice.customer,
      items: typedInvoice.items ?? [],
      company: company as CompanySettings,
    })
    if (!result.ok) {
      const first = result.issues[0]
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: first?.messageSv,
        messageEn: first?.messageEn,
        details: {
          issues: result.issues.map((item) => ({
            code: item.code,
            field: item.field,
            message_sv: item.messageSv,
            message_en: item.messageEn,
          })),
        },
      }))
    }

    return new NextResponse(result.xml, {
      status: 200,
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'Content-Disposition': contentDisposition('attachment', result.filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  },
)
