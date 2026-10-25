import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { saveAutogiroSettings } from '@/lib/invoices/autogiro/service'

const BodySchema = z.object({
  /** Kundnummer at Bankgirot, from the Autogiro agreement. */
  customer_number: z.string().trim().min(1).max(10),
  /** The bankgiro the debits are credited to. */
  bankgiro: z.string().trim().min(7).max(12),
})

/**
 * PUT /api/invoices/autogiro/settings: the company's Autogiro agreement
 * (Bankgirot Kundnummer and the receiving bankgiro). No seal key: the
 * company uploads the files in its own bank, which signs them.
 */
export const PUT = withRouteContext(
  'autogiro.settings',
  async (request, { supabase, companyId, log, requestId }) => {
    if (!isAutogiroEnabled(companyId)) return errorResponseFromCode('AUTOGIRO_NOT_ENABLED', log, { requestId })
    const body = await validateBody(request, BodySchema, { log, operation: 'autogiro.settings' })
    if (!body.success) return body.response
    const result = await saveAutogiroSettings(supabase, companyId, body.data)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    return NextResponse.json({ data: { settings: result.settings } })
  },
  { requireWrite: true },
)
