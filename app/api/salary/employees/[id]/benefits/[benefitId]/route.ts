import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateEmployeeBenefitSchema } from '@/lib/api/schemas'
import { calculateBikeBenefit } from '@/lib/salary/benefits'

ensureInitialized()

export const PATCH = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.update',
  async (request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const validation = await validateBody(request, UpdateEmployeeBenefitSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing, error: fetchError } = await supabase
      .from('employee_benefits')
      .select('benefit_type, metadata')
      .eq('id', benefitId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .single()

    if (fetchError || !existing) {
      return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
    }

    const updates: Record<string, unknown> = { ...body }

    if (body.annual_market_value !== undefined) {
      if (existing.benefit_type !== 'bike') {
        return NextResponse.json(
          { error: 'annual_market_value gäller endast cykelförmån' },
          { status: 400 },
        )
      }
      const calc = calculateBikeBenefit(body.annual_market_value)
      updates.monthly_value = calc.monthlyValue
      updates.metadata = {
        ...(existing.metadata as Record<string, unknown> ?? {}),
        ...(body.metadata ?? {}),
        annual_market_value: body.annual_market_value,
        annual_taxable: calc.annualTaxable,
        tax_free_portion: calc.taxFreePortion,
      }
      delete (updates as Record<string, unknown>).annual_market_value
    }

    const { data, error } = await supabase
      .from('employee_benefits')
      .update(updates)
      .eq('id', benefitId)
      .eq('employee_id', id)
      .eq('company_id', companyId)
      .select()
      .single()

    if (error || !data) {
      return NextResponse.json({ error: 'Förmån hittades inte' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string; benefitId: string }> }>(
  'salary.employees.benefits.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id, benefitId } = await params

    const { error } = await supabase
      .from('employee_benefits')
      .delete()
      .eq('id', benefitId)
      .eq('employee_id', id)
      .eq('company_id', companyId)

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })

    return NextResponse.json({ data: { id: benefitId, deleted: true } })
  },
  { requireWrite: true },
)
