/**
 * /api/dimensions/rules — per-account dimension policy (dimensions PR10).
 *
 * GET  ?account_number=4010 (optional) → every rule (or the account's).
 * POST → create a rule. 'required' blocks posting on the account without a
 * value for the dimension (enforced at commitEntry + the bulk-book route);
 * 'default' pre-fills at draft creation; 'fixed' always applies.
 *
 * Opt-in by construction: zero rules = the engine behaves exactly as before.
 * There is deliberately NO settings toggle for enforcement — a rule that
 * exists but is ignored would be worse than either extreme; pausing a single
 * rule is what is_active is for.
 */
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody, validateQuery } from '@/lib/api/validate'
import { CreateAccountDimensionRuleSchema, ListDimensionRulesQuerySchema } from '@/lib/api/schemas'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { RULE_SELECT, toRuleDto, type RawRule } from './dto'

ensureInitialized()


export const GET = withRouteContext(
  'dimension.rules.list',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const queryValidation = validateQuery(request, ListDimensionRulesQuerySchema, {
      log,
      operation: 'dimension.rules.list',
    })
    if (!queryValidation.success) return queryValidation.response
    const { account_number: accountNumber } = queryValidation.data

    let query = supabase
      .from('account_dimension_rules')
      .select(RULE_SELECT)
      .eq('company_id', companyId)
      .order('account_number', { ascending: true })

    if (accountNumber) {
      query = query.eq('account_number', accountNumber)
    }

    const { data, error } = await query
    if (error) {
      log.error('dimension rule list failed', error)
      return errorResponse(error, log, { requestId })
    }

    return NextResponse.json({
      data: { rules: ((data ?? []) as unknown as RawRule[]).map(toRuleDto) },
    })
  },
)

export const POST = withRouteContext(
  'dimension.rules.create',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const validation = await validateBody(request, CreateAccountDimensionRuleSchema)
    if (!validation.success) return validation.response
    const body = validation.data

    // The dimension must belong to this company (RLS backstops; this gives a
    // clean Swedish 400 instead of an FK error).
    const { data: dimension, error: dimensionError } = await supabase
      .from('dimensions')
      .select('id, is_active')
      .eq('id', body.dimension_id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (dimensionError) return errorResponse(dimensionError, log, { requestId })
    if (!dimension) {
      return NextResponse.json(
        { error: { code: 'DIMENSION_NOT_FOUND', message: 'Dimensionen finns inte i registret.' } },
        { status: 404 },
      )
    }

    // default/fixed: the value must belong to the SAME dimension + company
    // and be active — a rule pointing at a foreign or archived value would
    // make every booking on the account fail registry validation.
    if (body.value_id) {
      const { data: value, error: valueError } = await supabase
        .from('dimension_values')
        .select('id, is_active')
        .eq('id', body.value_id)
        .eq('company_id', companyId)
        .eq('dimension_id', body.dimension_id)
        .maybeSingle()
      if (valueError) return errorResponse(valueError, log, { requestId })
      if (!value) {
        return NextResponse.json(
          { error: { code: 'DIMENSION_VALUE_NOT_FOUND', message: 'Värdet finns inte under den valda dimensionen.' } },
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

    // The account must exist and be active in the company chart — a rule on
    // a nonexistent account can never fire and only confuses.
    const { data: account, error: accountError } = await supabase
      .from('chart_of_accounts')
      .select('account_number')
      .eq('company_id', companyId)
      .eq('account_number', body.account_number)
      .eq('is_active', true)
      .maybeSingle()
    if (accountError) return errorResponse(accountError, log, { requestId })
    if (!account) {
      return NextResponse.json(
        { error: { code: 'ACCOUNT_NOT_FOUND', message: `Konto ${body.account_number} finns inte som aktivt konto i kontoplanen.` } },
        { status: 404 },
      )
    }

    const { data: rule, error: insertError } = await supabase
      .from('account_dimension_rules')
      .insert({
        company_id: companyId,
        account_number: body.account_number,
        dimension_id: body.dimension_id,
        rule_type: body.rule_type,
        value_id: body.value_id ?? null,
        is_active: body.is_active ?? true,
      })
      .select(RULE_SELECT)
      .single()

    if (insertError) {
      if (insertError.code === '23505') {
        return NextResponse.json(
          { error: { code: 'DIMENSION_RULE_EXISTS', message: `Konto ${body.account_number} har redan en regel för den dimensionen.` } },
          { status: 409 },
        )
      }
      log.error('dimension rule create failed', insertError)
      return errorResponse(insertError, log, { requestId })
    }

    return NextResponse.json(
      { data: { rule: toRuleDto(rule as unknown as RawRule) } },
      { status: 201 },
    )
  },
  { requireWrite: true },
)
