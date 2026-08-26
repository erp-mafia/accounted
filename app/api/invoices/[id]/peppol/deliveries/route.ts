import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { getPeppolAccessSummary } from '@/lib/invoices/peppol-access'
import { listPeppolDeliverySummaries } from '@/lib/invoices/peppol-delivery'
import { getPeppolTransportAvailability } from '@/lib/invoices/peppol-transport'
import { createServiceClient } from '@/lib/supabase/server'

ensureInitialized()

const paramsSchema = z.object({ id: z.uuid() })

export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.peppol.deliveries.list',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const parsedParams = paramsSchema.safeParse(await params)
    if (!parsedParams.success) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { fields: parsedParams.error.flatten().fieldErrors },
      }))
    }
    const invoiceId = parsedParams.data.id

    const { data: invoice, error: invoiceError } = await supabase
      .from('invoices')
      .select('id')
      .eq('id', invoiceId)
      .eq('company_id', companyId)
      .single()
    if (invoiceError || !invoice) {
      return privateNoStore(errorResponseFromCode('INVOICE_NOT_FOUND', log, { requestId }))
    }

    try {
      const deliveries = await listPeppolDeliverySummaries({
        supabase,
        companyId,
        invoiceId,
      })
      const access = await getPeppolAccessSummary({ supabase, service: createServiceClient(), companyId })
      return privateNoStore(NextResponse.json({
        data: deliveries,
        transport: getPeppolTransportAvailability(),
        access,
      }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
)
