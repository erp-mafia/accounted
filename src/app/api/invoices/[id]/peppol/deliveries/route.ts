import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import { listInvoicePeppolDeliveries } from '@/lib/invoices/peppol-send-service'
import { sessionFailureResponse } from '@/lib/operations/session'
import { createServiceClient } from '@/lib/supabase/server'

ensureInitialized()

const paramsSchema = z.object({ id: z.uuid() })

/**
 * GET /api/invoices/[id]/peppol/deliveries: the invoice's Peppol deliveries
 * with the transport and access state. Shared with the v1 operation
 * invoices.peppol-deliveries (lib/invoices/peppol-send-service.ts).
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'invoice.peppol.deliveries.list',
  async (_request, { supabase, companyId, user, log, requestId }, { params }) => {
    const parsedParams = paramsSchema.safeParse(await params)
    if (!parsedParams.success) {
      return privateNoStore(errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { fields: parsedParams.error.flatten().fieldErrors },
      }))
    }

    const outcome = await listInvoicePeppolDeliveries(
      { supabase, companyId, userId: user.id, log },
      parsedParams.data.id,
      { service: createServiceClient() },
    )
    if (!outcome.ok) return privateNoStore(sessionFailureResponse(outcome, log, requestId))
    if (outcome.dryRun) return privateNoStore(NextResponse.json({ data: outcome.preview }))
    return privateNoStore(NextResponse.json({
      data: outcome.data.deliveries,
      transport: outcome.data.transport,
      access: outcome.data.access,
    }))
  },
)
