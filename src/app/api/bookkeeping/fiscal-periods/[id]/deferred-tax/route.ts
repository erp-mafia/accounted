import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { validateBody } from '@/lib/api/validate'
import { buildDispositionsProposal } from '@/lib/bokslut/dispositions-proposal-builder'
import {
  DeferredTaxAssessmentSchema,
  deferredTaxMovements,
  loadDeferredTaxAssessment,
  saveDeferredTaxAssessment,
} from '@/lib/bokslut/tax-provision/deferred-tax-service'

type Params = { params: Promise<{ id: string }> }

async function loadPeriod(
  supabase: Parameters<typeof loadDeferredTaxAssessment>[0],
  companyId: string,
  id: string,
) {
  const { data, error } = await supabase
    .from('fiscal_periods')
    .select('id, is_closed, locked_at, closing_entry_id')
    .eq('id', id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (error) throw new Error(`Kunde inte läsa räkenskapsåret: ${error.message}`)
  return data as { id: string; is_closed: boolean; locked_at: string | null; closing_entry_id: string | null } | null
}

/**
 * The uppskjuten skatt inputs of a K3 fiscal year (K3 kap. 29) and the
 * year's movements on 2240/1370 and per kind of temporary difference.
 */
export const GET = withRouteContext<Params>('period.deferred_tax.get', async (_request, ctx, { params }) => {
  const { id } = await params
  const { supabase, companyId, log, requestId } = ctx
  try {
    if (!(await loadPeriod(supabase, companyId, id))) {
      return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
    }
    const [assessment, movements] = await Promise.all([
      loadDeferredTaxAssessment(supabase, companyId, id),
      deferredTaxMovements(supabase, companyId, id),
    ])
    return NextResponse.json({ data: { assessment, movements } })
  } catch (err) {
    return errorResponse(err, log, { requestId })
  }
})

/**
 * Save the inputs (whether the loss carried forward is recognised and why,
 * K3 29.29, and temporary differences entered by hand) and answer the
 * year-end dispositions as they now stand, as the dispositions PUT does.
 */
export const PUT = withRouteContext<Params>(
  'period.deferred_tax.save',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { user, supabase, companyId, log, requestId } = ctx
    const validation = await validateBody(request, DeferredTaxAssessmentSchema)
    if (!validation.success) return validation.response
    try {
      const period = await loadPeriod(supabase, companyId, id)
      if (!period) return errorResponseFromCode('PERIOD_NOT_FOUND', log, { requestId })
      if (period.is_closed || period.locked_at || period.closing_entry_id) {
        return errorResponseFromCode('PERIOD_LOCKED', log, { requestId })
      }
      await saveDeferredTaxAssessment(supabase, companyId, user.id, id, validation.data)
      const data = await buildDispositionsProposal(supabase, companyId, id)
      return NextResponse.json({ data })
    } catch (err) {
      return errorResponse(err, log, { requestId })
    }
  },
  { requireWrite: true },
)
