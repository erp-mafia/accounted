import { NextResponse } from 'next/server'
import { z } from 'zod'
import { contentDisposition } from '@/lib/api/content-disposition'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { stagePeppolDelivery } from '@/lib/invoices/peppol-delivery'
import { loadPeppolDocument } from '@/lib/invoices/peppol-document'
import { getPeppolTransportAvailability } from '@/lib/invoices/peppol-transport'

// Registers the configured Access Point adapter so `transport` below reports
// the truth for this process, not just "nothing registered yet".
ensureInitialized()

const paramsSchema = z.object({ id: z.uuid() })

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
    if (!loaded.ok) return loaded.response
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
    if (!loaded.ok) return loaded.response

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
