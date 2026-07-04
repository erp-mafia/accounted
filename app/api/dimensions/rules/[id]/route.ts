/**
 * /api/dimensions/rules/[id] — mutate one account dimension rule (PR10).
 *
 * PATCH  { rule_type?, value_id?, is_active? } — value presence is
 *        re-validated against the EFFECTIVE rule_type (required ⇔ no value).
 * DELETE — removes the rule; enforcement stops immediately. Pausing without
 *          losing the configuration is is_active: false.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { UpdateAccountDimensionRuleSchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { RULE_SELECT, toRuleDto, type RawRule } from '../dto'

ensureInitialized()

export const PATCH = withRouteContext<{ params: Promise<{ id: string }> }>(
  'dimension.rules.update',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, UpdateAccountDimensionRuleSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    const { data: existing, error: existingError } = await supabase
      .from('account_dimension_rules')
      .select('id, rule_type, value_id, dimension_id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (existingError) return errorResponse(existingError, log, { requestId })
    if (!existing) {
      return NextResponse.json(
        { error: { code: 'DIMENSION_RULE_NOT_FOUND', message: 'Regeln finns inte.' } },
        { status: 404 },
      )
    }

    const effectiveType = body.rule_type ?? (existing.rule_type as string)
    const effectiveValueId =
      body.value_id !== undefined ? body.value_id : (existing.value_id as string | null)

    if (effectiveType === 'required' && effectiveValueId) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_FAILED', message: 'En obligatorisk regel har inget värde — ta bort värdet eller byt regeltyp.' } },
        { status: 400 },
      )
    }
    if (effectiveType !== 'required' && !effectiveValueId) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_FAILED', message: 'Välj vilket värde regeln ska använda.' } },
        { status: 400 },
      )
    }

    if (body.value_id) {
      const { data: value, error: valueError } = await supabase
        .from('dimension_values')
        .select('id, is_active')
        .eq('id', body.value_id)
        .eq('company_id', companyId)
        .eq('dimension_id', existing.dimension_id)
        .maybeSingle()
      if (valueError) return errorResponse(valueError, log, { requestId })
      if (!value) {
        return NextResponse.json(
          { error: { code: 'DIMENSION_VALUE_NOT_FOUND', message: 'Värdet finns inte under regelns dimension.' } },
          { status: 404 },
        )
      }
      if (!value.is_active) {
        return NextResponse.json(
          { error: { code: 'DIMENSION_VALUE_ARCHIVED', message: 'Värdet är arkiverat — återaktivera det innan det används i en regel.' } },
          { status: 400 },
        )
      }
    }

    const updates: Record<string, unknown> = {}
    if (body.rule_type !== undefined) updates.rule_type = body.rule_type
    if (body.value_id !== undefined) updates.value_id = body.value_id
    if (body.is_active !== undefined) updates.is_active = body.is_active
    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_FAILED', message: 'Ingen ändring angiven.' } },
        { status: 400 },
      )
    }

    const { data: rule, error: updateError } = await supabase
      .from('account_dimension_rules')
      .update(updates)
      .eq('id', id)
      .eq('company_id', companyId)
      .select(RULE_SELECT)
      .single()

    if (updateError) {
      log.error('dimension rule update failed', updateError)
      return errorResponse(updateError, log, { requestId })
    }

    return NextResponse.json({ data: { rule: toRuleDto(rule as unknown as RawRule) } })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'dimension.rules.delete',
  async (_request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, log, requestId } = ctx

    const { error, count } = await supabase
      .from('account_dimension_rules')
      .delete({ count: 'exact' })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      log.error('dimension rule delete failed', error)
      return errorResponse(error, log, { requestId })
    }
    if (!count) {
      return NextResponse.json(
        { error: { code: 'DIMENSION_RULE_NOT_FOUND', message: 'Regeln finns inte.' } },
        { status: 404 },
      )
    }

    return NextResponse.json({ data: { deleted: true } })
  },
  { requireWrite: true },
)
