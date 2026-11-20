import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { isAutogiroEnabled } from '@/lib/invoices/autogiro/flag'
import { addExistingMandate, loadAutogiroSettings } from '@/lib/invoices/autogiro/service'

const QuerySchema = z.object({ customer_id: z.uuid() })

const BodySchema = z.object({
  customer_id: z.uuid(),
  /** The betalarnummer the customer's mandate has at Bankgirot. */
  payer_number: z.string().trim().min(1).max(20),
})

/**
 * GET /api/invoices/autogiro/mandates?customer_id=: one customer's Autogiro
 * mandates (the customer card), newest first, and whether the company can
 * add one (`enabled`, `settings_ready`).
 */
export const GET = withRouteContext('autogiro.mandates.list', async (request, { supabase, companyId, log }) => {
  const query = validateQuery(request, QuerySchema, { log, operation: 'autogiro.mandates.list' })
  if (!query.success) return query.response
  const [settings, { data, error }] = await Promise.all([
    loadAutogiroSettings(supabase, companyId),
    supabase
      .from('autogiro_mandates')
      .select('id, customer_id, payer_number, status, source, payer_name, status_text, status_changed_on, created_at')
      .eq('company_id', companyId)
      .eq('customer_id', query.data.customer_id)
      .order('created_at', { ascending: false }),
  ])
  if (error) throw error
  return NextResponse.json({
    data: { enabled: isAutogiroEnabled(companyId), settings_ready: settings !== null, mandates: data ?? [] },
  })
})

/**
 * POST /api/invoices/autogiro/mandates: registers a mandate the customer
 * already gave on the company's bankgiro (moved from another system), by its
 * payer number. Bankgirot holds the account; a wrong payer number shows as a
 * rejected debit.
 */
export const POST = withRouteContext(
  'autogiro.mandates.add',
  async (request, { supabase, companyId, log, requestId }) => {
    if (!isAutogiroEnabled(companyId)) return errorResponseFromCode('AUTOGIRO_NOT_ENABLED', log, { requestId })
    const body = await validateBody(request, BodySchema, { log, operation: 'autogiro.mandates.add' })
    if (!body.success) return body.response
    const result = await addExistingMandate(supabase, companyId, body.data)
    if (!result.ok) return errorResponseFromCode(result.code, log, { requestId, details: result.details })
    return NextResponse.json({ data: { mandate: result.mandate } }, { status: 201 })
  },
  { requireWrite: true },
)
