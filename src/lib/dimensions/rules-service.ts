/**
 * Account dimension rules (account_dimension_rules, dimensions PR10): per
 * account and dimension, 'required' (the account cannot be posted without
 * a value), 'default' (pre-filled on a line that has none) or 'fixed'
 * (always applied). The engine reads them (lib/bookkeeping/
 * dimension-rules.ts); this service writes them, the one implementation
 * behind the dashboard routes (/api/dimensions/rules), the v1 operations
 * and their MCP tools (lib/operations/dimension-rules.ts):
 *
 *   - the dimension must be the company's;
 *   - a default/fixed value must be an ACTIVE value of that same dimension:
 *     a rule on a foreign or archived value would make every booking on the
 *     account fail registry validation;
 *   - the account must be an active account in the chart: a rule on a
 *     missing account never fires and only confuses;
 *   - required carries no value, default and fixed carry one
 *     (ruleValueProblem): the request schema checks a create, this service
 *     checks an update against the rule's effective type;
 *   - one rule per account and dimension: the DB UNIQUE is the arbiter.
 *
 * Any member who may write may write rules (RLS on user_company_ids, the
 * dashboard's requireWrite), so there is no owner/admin gate. A dry run runs
 * every check and writes nothing.
 */
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { ruleValueProblem, type DimensionRuleType } from './rule-value'

export const RULE_SELECT =
  'id, account_number, rule_type, value_id, is_active, dimension:dimensions!account_dimension_rules_dimension_id_company_id_fkey(id, sie_dim_no, name), value:dimension_values!account_dimension_rules_value_id_fkey(code, name)'

export interface RawRule {
  id: string
  account_number: string
  rule_type: DimensionRuleType
  value_id: string | null
  is_active: boolean
  dimension: { id: string; sie_dim_no: number; name: string }
  value: { code: string; name: string } | null
}

/** The public shape of a rule: the dashboard's DTO, qualified ids throughout. */
export function toRuleDto(row: RawRule) {
  return {
    account_dimension_rule_id: row.id,
    account_number: row.account_number,
    dimension_id: row.dimension.id,
    sie_dim_no: row.dimension.sie_dim_no,
    dimension_name: row.dimension.name,
    rule_type: row.rule_type,
    value_id: row.value_id,
    value_code: row.value?.code ?? null,
    value_name: row.value?.name ?? null,
    is_active: row.is_active,
  }
}

export type AccountDimensionRuleDto = ReturnType<typeof toRuleDto>

const RULE_NOT_FOUND = { ok: false as const, code: 'DIMENSION_RULE_NOT_FOUND' }

function failed(error: unknown): Extract<OperationOutcome<never>, { ok: false }> {
  return { ok: false, code: 'UNKNOWN_ERROR', error }
}

/** Every rule of the company (or of one account), by account number. */
export async function listAccountDimensionRules(
  ctx: OperationContext,
  filter: { account_number?: string } = {},
): Promise<OperationOutcome<{ rules: AccountDimensionRuleDto[] }>> {
  try {
    const rows = await fetchAllRows(({ from, to }) => {
      let query = ctx.supabase.from('account_dimension_rules').select(RULE_SELECT).eq('company_id', ctx.companyId)
      if (filter.account_number) query = query.eq('account_number', filter.account_number)
      return query.order('account_number', { ascending: true }).order('id', { ascending: true }).range(from, to)
    })
    // The generated types read each embed as an array; both are to-one
    // (composite FKs), so every row carries one object or null. Same cast as
    // fetchActiveDimensionRules in lib/bookkeeping/dimension-rules.ts.
    return { ok: true, data: { rules: (rows as unknown as RawRule[]).map(toRuleDto) } }
  } catch (error) {
    ctx.log.error('dimension rule list failed', error as Error)
    return failed(error)
  }
}

/**
 * The value a default/fixed rule points at must be an active value of the
 * rule's own dimension in this company.
 */
async function checkRuleValue(
  ctx: OperationContext,
  dimensionId: string,
  valueId: string,
  notFoundSv: string,
): Promise<Extract<OperationOutcome<never>, { ok: false }> | null> {
  const { data: value, error } = await ctx.supabase
    .from('dimension_values')
    .select('id, is_active')
    .eq('id', valueId)
    .eq('company_id', ctx.companyId)
    .eq('dimension_id', dimensionId)
    .maybeSingle()
  if (error) return failed(error)
  if (!value) {
    return { ok: false, code: 'DIMENSION_VALUE_NOT_FOUND', messageSv: notFoundSv, details: { value_id: valueId } }
  }
  if (!value.is_active) return { ok: false, code: 'DIMENSION_VALUE_ARCHIVED', details: { value_id: valueId } }
  return null
}

export interface CreateAccountDimensionRuleInput {
  account_number: string
  dimension_id: string
  rule_type: DimensionRuleType
  value_id?: string | null
  is_active?: boolean
}

export async function createAccountDimensionRule(
  ctx: OperationContext,
  input: CreateAccountDimensionRuleInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ rule: AccountDimensionRuleDto }>> {
  const { supabase, companyId, log } = ctx

  // The dimension must belong to this company (the composite FK backstops
  // it; this answers a clean refusal instead of an FK error).
  const { data: dimension, error: dimensionError } = await supabase
    .from('dimensions')
    .select('id, is_active')
    .eq('id', input.dimension_id)
    .eq('company_id', companyId)
    .maybeSingle()
  if (dimensionError) return failed(dimensionError)
  if (!dimension) {
    return {
      ok: false,
      code: 'DIMENSION_NOT_FOUND',
      messageSv: 'Dimensionen finns inte i registret.',
      details: { dimension_id: input.dimension_id },
    }
  }

  if (input.value_id) {
    const refused = await checkRuleValue(
      ctx,
      input.dimension_id,
      input.value_id,
      'Värdet finns inte under den valda dimensionen.',
    )
    if (refused) return refused
  }

  const { data: account, error: accountError } = await supabase
    .from('chart_of_accounts')
    .select('account_number')
    .eq('company_id', companyId)
    .eq('account_number', input.account_number)
    .eq('is_active', true)
    .maybeSingle()
  if (accountError) return failed(accountError)
  if (!account) {
    return {
      ok: false,
      code: 'ACCOUNT_NOT_FOUND',
      messageSv: `Konto ${input.account_number} finns inte som aktivt konto i kontoplanen.`,
      details: { account_number: input.account_number },
    }
  }

  const row = {
    account_number: input.account_number,
    dimension_id: input.dimension_id,
    rule_type: input.rule_type,
    value_id: input.value_id ?? null,
    is_active: input.is_active ?? true,
  }

  if (options.dryRun) {
    // The UNIQUE decides at insert; the preview looks it up so a stage is
    // refused up front instead of at approval.
    const { data: existing, error: existingError } = await supabase
      .from('account_dimension_rules')
      .select('id')
      .eq('company_id', companyId)
      .eq('account_number', input.account_number)
      .eq('dimension_id', input.dimension_id)
      .maybeSingle()
    if (existingError) return failed(existingError)
    if (existing) return ruleExists(input.account_number, existing.id as string)
    return { ok: true, dryRun: true, preview: { account_dimension_rule_id: null, ...row } }
  }

  const { data: rule, error: insertError } = await supabase
    .from('account_dimension_rules')
    .insert({
      company_id: companyId,
      account_number: row.account_number,
      dimension_id: row.dimension_id,
      rule_type: row.rule_type,
      value_id: row.value_id,
      is_active: row.is_active,
    })
    .select(RULE_SELECT)
    .single()
  if (insertError) {
    if (insertError.code === '23505') return ruleExists(input.account_number)
    log.error('dimension rule create failed', insertError)
    return failed(insertError)
  }
  return { ok: true, data: { rule: toRuleDto(rule as unknown as RawRule) }, created: true }
}

function ruleExists(accountNumber: string, ruleId?: string): Extract<OperationOutcome<never>, { ok: false }> {
  return {
    ok: false,
    code: 'DIMENSION_RULE_EXISTS',
    messageSv: `Konto ${accountNumber} har redan en regel för den dimensionen.`,
    details: { account_number: accountNumber, ...(ruleId ? { account_dimension_rule_id: ruleId } : {}) },
  }
}

export interface UpdateAccountDimensionRuleInput {
  rule_type?: DimensionRuleType
  value_id?: string | null
  is_active?: boolean
}

export async function updateAccountDimensionRule(
  ctx: OperationContext,
  ruleId: string,
  input: UpdateAccountDimensionRuleInput,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ rule: AccountDimensionRuleDto }>> {
  const { supabase, companyId, log } = ctx

  const { data: existing, error: existingError } = await supabase
    .from('account_dimension_rules')
    .select('id, rule_type, value_id, dimension_id')
    .eq('id', ruleId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (existingError) return failed(existingError)
  if (!existing) return RULE_NOT_FOUND

  // The value rule holds for the rule as it will be, not for the request:
  // switching a default rule to required must also clear its value.
  const effectiveType = input.rule_type ?? (existing.rule_type as DimensionRuleType)
  const effectiveValueId = input.value_id !== undefined ? input.value_id : (existing.value_id as string | null)
  const problem = ruleValueProblem(effectiveType, Boolean(effectiveValueId))
  if (problem) {
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      messageSv: problem,
      details: { field: 'value_id', rule_type: effectiveType },
    }
  }

  if (input.value_id) {
    const refused = await checkRuleValue(
      ctx,
      existing.dimension_id as string,
      input.value_id,
      'Värdet finns inte under regelns dimension.',
    )
    if (refused) return refused
  }

  const changes: Record<string, unknown> = {}
  if (input.rule_type !== undefined) changes.rule_type = input.rule_type
  if (input.value_id !== undefined) changes.value_id = input.value_id
  if (input.is_active !== undefined) changes.is_active = input.is_active
  if (Object.keys(changes).length === 0) {
    return { ok: false, code: 'VALIDATION_ERROR', messageSv: 'Ingen ändring angiven.' }
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: { account_dimension_rule_id: ruleId, changes, rule_type: effectiveType, value_id: effectiveValueId },
    }
  }

  const { data: rule, error: updateError } = await supabase
    .from('account_dimension_rules')
    .update(changes)
    .eq('id', ruleId)
    .eq('company_id', companyId)
    .select(RULE_SELECT)
    .single()
  if (updateError) {
    log.error('dimension rule update failed', updateError)
    return failed(updateError)
  }
  return { ok: true, data: { rule: toRuleDto(rule as unknown as RawRule) } }
}

/**
 * Remove a rule; enforcement stops at once. Pausing it without losing the
 * configuration is an update with is_active false.
 */
export async function deleteAccountDimensionRule(
  ctx: OperationContext,
  ruleId: string,
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<{ deleted: true; account_dimension_rule_id: string }>> {
  const { supabase, companyId, log } = ctx

  if (options.dryRun) {
    const { data: existing, error } = await supabase
      .from('account_dimension_rules')
      .select('id, account_number, rule_type, dimension_id')
      .eq('id', ruleId)
      .eq('company_id', companyId)
      .maybeSingle()
    if (error) return failed(error)
    if (!existing) return RULE_NOT_FOUND
    return {
      ok: true,
      dryRun: true,
      preview: {
        account_dimension_rule_id: ruleId,
        account_number: existing.account_number,
        dimension_id: existing.dimension_id,
        rule_type: existing.rule_type,
      },
    }
  }

  const { error, count } = await supabase
    .from('account_dimension_rules')
    .delete({ count: 'exact' })
    .eq('id', ruleId)
    .eq('company_id', companyId)
  if (error) {
    log.error('dimension rule delete failed', error)
    return failed(error)
  }
  if (!count) return RULE_NOT_FOUND
  return { ok: true, data: { deleted: true, account_dimension_rule_id: ruleId } }
}
