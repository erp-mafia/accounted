import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isFiscalPeriodMissingError, stagePeppolDelivery } from '@/lib/invoices/peppol-delivery'
import { loadPeppolDocument } from '@/lib/invoices/peppol-document'
import { getPeppolTransportAvailability } from '@/lib/invoices/peppol-transport'
import { fileResponse } from '@/lib/api/file-response'

const paramsSchema = z.object({ id: z.uuid() })
/**
 * preview=1 downloads a draft that has no invoice number yet (accounted#44):
 * placeholder number and OCR, a marked preview file that staging refuses. An
 * invoice that has its number gets its real document either way.
 */
const querySchema = z.object({ preview: z.enum(['0', '1']).optional() })

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.peppol',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const parsedParams = paramsSchema.safeParse(await params)
    const parsedQuery = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
    if (!parsedParams.success || !parsedQuery.success) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          fields: {
            ...(parsedParams.success ? {} : parsedParams.error.flatten().fieldErrors),
            ...(parsedQuery.success ? {} : parsedQuery.error.flatten().fieldErrors),
          },
        },
      }))
    }
    const { id } = parsedParams.data

    const loaded = await loadPeppolDocument({
      supabase,
      companyId,
      invoiceId: id,
      log,
      requestId,
      preview: parsedQuery.data.preview === '1',
    })
    if (!loaded.ok) return loaded.response
    const result = loaded.document

    return fileResponse(result.xml, {
      filename: result.filename,
      contentType: 'application/xml; charset=utf-8',
      cacheControl: 'private, no-store',
      headers: {
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
          transport: await getPeppolTransportAvailability(),
        },
      }, { status: 201 }))
    } catch (err) {
      if (isFiscalPeriodMissingError(err)) {
        return privateNoStore(errorResponseFromCode('PEPPOL_FISCAL_PERIOD_MISSING', log, {
          requestId,
          details: { invoice_date: loaded.invoice.invoice_date },
        }))
      }
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
  { requireWrite: true },
)
