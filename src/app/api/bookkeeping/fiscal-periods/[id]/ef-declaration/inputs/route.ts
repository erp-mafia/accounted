import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import {
  loadNeDeclarationInputs,
  NeDeclarationInputsSchema,
  saveNeDeclarationInputs,
} from '@/lib/bokslut/enskild-firma/declaration-inputs'

type Params = { params: Promise<{ id: string }> }

/**
 * GET /api/bookkeeping/fiscal-periods/{id}/ef-declaration/inputs
 *
 * What the owner has entered for the räkenskapsår's NE-bilaga sida 2, or,
 * with nothing saved yet, what last year's saved inputs hand on (source
 * 'carried'). A form that does not file NE-bilagan gets
 * EF_DECLARATION_WRONG_LEGAL_FORM.
 */
export const GET = withRouteContext<Params>(
  'period.ef_declaration_inputs.get',
  async (_request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params
    const { data: period, error } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw error
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    return NextResponse.json({ data: await loadNeDeclarationInputs(supabase, companyId!, id) })
  },
)

/**
 * PUT /api/bookkeeping/fiscal-periods/{id}/ef-declaration/inputs
 *
 * Replaces the räkenskapsår's inputs in the caller's name. Body: the
 * year-end preview's input (NeDeclarationInputsSchema). Declaration-only
 * figures: nothing is booked, and the year may already be closed.
 */
export const PUT = withRouteContext<Params>(
  'period.ef_declaration_inputs.put',
  async (request, { supabase, companyId, user, log, requestId }, { params }) => {
    const { id } = await params
    const body = await validateBody(request, NeDeclarationInputsSchema)
    if (!body.success) return body.response
    const { data: period, error } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) throw error
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })
    return NextResponse.json({ data: await saveNeDeclarationInputs(supabase, companyId!, id, user.id, body.data) })
  },
  { requireWrite: true },
)
