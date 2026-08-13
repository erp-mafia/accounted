import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { contentDisposition } from '@/lib/api/content-disposition'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { generatePeppolBisBillingInvoice } from '@/lib/invoices/peppol-bis-billing'
import { stagePeppolDelivery } from '@/lib/invoices/peppol-delivery'
import { getPeppolTransportAvailability } from '@/lib/invoices/peppol-transport'
import type { CompanySettings, Customer, Invoice, InvoiceItem } from '@/types'

const paramsSchema = z.object({ id: z.uuid() })

function privateNoStore(response: NextResponse): NextResponse {
  response.headers.set('Cache-Control', 'private, no-store')
  return response
}

async function loadPeppolDocument(args: {
  supabase: SupabaseClient
  companyId: string
  invoiceId: string
  log: Parameters<typeof errorResponseFromCode>[1]
  requestId: string
}) {
  const { data: invoice, error: invoiceError } = await args.supabase
    .from('invoices')
    .select(`
      *,
      customer:customers(*),
      items:invoice_items(*)
    `)
    .eq('id', args.invoiceId)
    .eq('company_id', args.companyId)
    .single()

  if (invoiceError || !invoice) {
    return {
      response: privateNoStore(errorResponseFromCode(
        'INVOICE_NOT_FOUND',
        args.log,
        { requestId: args.requestId },
      )),
    }
  }

  const { data: company, error: companyError } = await args.supabase
    .from('company_settings')
    .select('*')
    .eq('company_id', args.companyId)
    .single()

  if (companyError || !company) {
    return {
      response: privateNoStore(errorResponseFromCode(
        'INVOICE_SEND_COMPANY_SETTINGS_MISSING',
        args.log,
        { requestId: args.requestId },
      )),
    }
  }

  const typedInvoice = invoice as Invoice & { customer?: Customer; items?: InvoiceItem[] }
  if (!typedInvoice.customer) {
    return {
      response: privateNoStore(errorResponseFromCode('VALIDATION_ERROR', args.log, {
        requestId: args.requestId,
        messageSv: 'Fakturan saknar en kund som kan användas för Peppol-export.',
        messageEn: 'The invoice has no customer available for Peppol export.',
        details: { field: 'invoice.customer' },
      })),
    }
  }

  const document = generatePeppolBisBillingInvoice({
    invoice: typedInvoice,
    customer: typedInvoice.customer,
    items: typedInvoice.items ?? [],
    company: company as CompanySettings,
  })
  if (!document.ok) {
    const first = document.issues[0]
    return {
      response: privateNoStore(errorResponseFromCode('VALIDATION_ERROR', args.log, {
        requestId: args.requestId,
        messageSv: first?.messageSv,
        messageEn: first?.messageEn,
        details: {
          issues: document.issues.map((item) => ({
            code: item.code,
            field: item.field,
            message_sv: item.messageSv,
            message_en: item.messageEn,
          })),
        },
      })),
    }
  }

  return { document }
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

    const loaded = await loadPeppolDocument({ supabase, companyId, invoiceId: id, log, requestId })
    if ('response' in loaded) return loaded.response
    const result = loaded.document

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

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.peppol.stage',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsedParams = paramsSchema.safeParse(await params)
    if (!parsedParams.success) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { fields: parsedParams.error.flatten().fieldErrors },
      }))
    }

    const invoiceId = parsedParams.data.id
    const loaded = await loadPeppolDocument({
      supabase,
      companyId,
      invoiceId,
      log,
      requestId,
    })
    if ('response' in loaded) return loaded.response

    try {
      const delivery = await stagePeppolDelivery({
        supabase,
        companyId,
        invoiceId,
        document: loaded.document,
      })
      return privateNoStore(NextResponse.json({
        data: {
          id: delivery.id,
          idempotency_key: delivery.idempotency_key,
          xml_sha256: delivery.xml_sha256,
          status: delivery.status,
          created_at: delivery.created_at,
          network_submitted: false,
          transport: getPeppolTransportAvailability(),
        },
      }, { status: 201 }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
  { requireWrite: true },
)
