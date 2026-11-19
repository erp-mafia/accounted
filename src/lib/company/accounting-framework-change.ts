/**
 * Changing the K2/K3 framework of a räkenskapsår. One rule for every door
 * (the settings form through PATCH /api/company/current, and any later API
 * door), applied in the database by set_fiscal_period_framework (migration
 * 20261030040201) so no door can skip it:
 *
 *   - BFNAR 2012:4 punkt 2: a company may always switch to K3. A switch from
 *     K3 to K2 needs särskilda skäl when the company applied K2 (or BFNAR
 *     2008:1 / 2009:1) earlier, and tax reasons are not särskilda skäl.
 *   - punkt 3: a switch is a change of accounting principle, and the reasons
 *     for a switch from K3 to K2 are stated in a note (the K2 årsredovisning
 *     prints change_reason).
 *   - A switch is judged against the previous årsredovisning's framework:
 *     from the previous year's record when it is reliable (an election, its
 *     locked årsredovisning, or a year that followed one), else as the user
 *     states it (previous_year_framework). A company default is never taken
 *     as the framework a year was prepared under.
 *   - The year must be open: not closed, not locked, its bookkeeping not
 *     locked through its last day, and no årsredovisning version past draft.
 *
 * The legal form is checked here, from its profile: only a form that offers
 * K3 can carry it (supportsAccountingFramework); the database function checks
 * the same, since it is granted to authenticated. The change cascades to the
 * later years that only followed this one, and the company default follows
 * the latest year. Every change writes an audit_log row (table trigger) and
 * emits `company.accounting_framework_changed`.
 */
import { eventBus } from '@/lib/events/bus'
import { codedRefusal } from '@/lib/errors/refusal'
import { isEntityType, supportsAccountingFramework } from '@/lib/company/entity-type'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { OperationContext } from '@/lib/operations/types'
import type { AccountingFramework } from '@/types'
import { listFiscalYears, pickCurrentFiscalYear } from './accounting-framework'

export interface AccountingFrameworkChangeInput {
  framework: AccountingFramework
  /** The year to change; omitted means the year running today. */
  fiscal_period_id?: string
  /** BFNAR 2012:4 punkt 3: why the company leaves K3 for K2 (required then). */
  change_reason?: string | null
  /** Whether the company applied a K2 regelverk before (asked when Accounted cannot tell). */
  previously_applied_k2?: boolean | null
  /** The reasons are särskilda skäl, not tax reasons (required after earlier K2). */
  special_reasons_confirmed?: boolean | null
  /**
   * The framework the previous årsredovisning was prepared under (none: the
   * company has no previous årsredovisning), asked when Accounted holds no
   * reliable record of it and the year leaves K3 for K2.
   */
  previous_year_framework?: AccountingFramework | 'none' | null
}

export interface AccountingFrameworkChangeResult {
  /** Null when the company has no fiscal year yet: only the default changed. */
  fiscal_period_id: string | null
  framework: AccountingFramework
  previous_framework: AccountingFramework | null
  changed: boolean
  k3_to_k2: boolean
  cascaded_period_ids: string[]
  company_framework: AccountingFramework
  dry_run: boolean
}

/** Refusal codes of set_fiscal_period_framework, with their structured-error codes. */
const RPC_CODES: Record<string, string> = {
  FRAMEWORK_FORBIDDEN: 'ACCOUNTING_FRAMEWORK_FORBIDDEN',
  FRAMEWORK_INVALID: 'VALIDATION_ERROR',
  FRAMEWORK_FORM_UNSUPPORTED: 'ACCOUNTING_FRAMEWORK_FORM_UNSUPPORTED',
  FRAMEWORK_K2_NOT_ALLOWED: 'ACCOUNTING_FRAMEWORK_K2_NOT_ALLOWED',
  FRAMEWORK_PREVIOUS_YEAR_UNKNOWN: 'ACCOUNTING_FRAMEWORK_PREVIOUS_YEAR_UNKNOWN',
  FRAMEWORK_PERIOD_NOT_FOUND: 'ACCOUNTING_FRAMEWORK_PERIOD_NOT_FOUND',
  FRAMEWORK_PERIOD_CLOSED: 'ACCOUNTING_FRAMEWORK_PERIOD_CLOSED',
  FRAMEWORK_REPORT_LOCKED: 'ACCOUNTING_FRAMEWORK_REPORT_LOCKED',
  FRAMEWORK_REASON_REQUIRED: 'ACCOUNTING_FRAMEWORK_REASON_REQUIRED',
  FRAMEWORK_PREVIOUS_K2_UNKNOWN: 'ACCOUNTING_FRAMEWORK_PREVIOUS_K2_UNKNOWN',
  FRAMEWORK_SPECIAL_REASONS_REQUIRED: 'ACCOUNTING_FRAMEWORK_SPECIAL_REASONS_REQUIRED',
}

interface RpcResult {
  ok?: boolean
  code?: string
  changed?: boolean
  framework?: AccountingFramework
  previous_framework?: AccountingFramework | null
  k3_to_k2?: boolean
  fiscal_period_id?: string
  cascaded_period_ids?: string[]
  company_framework?: AccountingFramework
}

/**
 * Change the framework of one year (or of the current one). Throws a coded
 * refusal (structured-errors ACCOUNTING_FRAMEWORK_*) the doors turn into the
 * canonical error envelope.
 */
export async function changeAccountingFramework(
  ctx: Pick<OperationContext, 'supabase' | 'companyId' | 'userId'>,
  input: AccountingFrameworkChangeInput,
  { dryRun = false, todayIso = todayIsoStockholm() }: { dryRun?: boolean; todayIso?: string } = {},
): Promise<AccountingFrameworkChangeResult> {
  const { supabase, companyId, userId } = ctx

  const { data: company, error: companyError } = await supabase
    .from('companies')
    .select('entity_type, accounting_framework')
    .eq('id', companyId)
    .maybeSingle()
  if (companyError) throw new Error(`Failed to load the company: ${companyError.message}`)
  if (!company) throw codedRefusal('ACCOUNTING_FRAMEWORK_PERIOD_NOT_FOUND', 'Company not found.')
  const entityType = (company as { entity_type?: string | null }).entity_type
  if (
    input.framework === 'k3'
    && !(isEntityType(entityType) && supportsAccountingFramework(entityType, 'K3'))
  ) {
    throw codedRefusal(
      'ACCOUNTING_FRAMEWORK_FORM_UNSUPPORTED',
      'K3 (BFNAR 2012:1) is not offered for this legal form.',
    )
  }

  let fiscalPeriodId = input.fiscal_period_id ?? null
  if (!fiscalPeriodId) {
    const year = pickCurrentFiscalYear(await listFiscalYears(supabase, companyId), todayIso)
    fiscalPeriodId = year?.id ?? null
  }

  // No fiscal year yet (onboarding): the company default is the only value,
  // and the first year will follow it. There is no årsredovisning to protect.
  if (!fiscalPeriodId) {
    const previous = (company as { accounting_framework?: AccountingFramework }).accounting_framework ?? 'k2'
    if (!dryRun && previous !== input.framework) {
      const { error } = await supabase
        .from('companies')
        .update({ accounting_framework: input.framework })
        .eq('id', companyId)
      if (error) throw error
      await eventBus.emit({
        type: 'company.accounting_framework_changed',
        payload: {
          companyId,
          userId,
          fiscalPeriodId: null,
          framework: input.framework,
          previousFramework: previous,
          cascadedPeriodIds: [],
          k3ToK2: false,
        },
      })
    }
    return {
      fiscal_period_id: null,
      framework: input.framework,
      previous_framework: previous,
      changed: previous !== input.framework,
      k3_to_k2: false,
      cascaded_period_ids: [],
      company_framework: input.framework,
      dry_run: dryRun,
    }
  }

  const { data, error } = await supabase.rpc('set_fiscal_period_framework', {
    p_company_id: companyId,
    p_fiscal_period_id: fiscalPeriodId,
    p_framework: input.framework,
    p_change_reason: input.change_reason?.trim() || null,
    p_previously_applied_k2: input.previously_applied_k2 ?? null,
    p_special_reasons_confirmed: input.special_reasons_confirmed ?? null,
    p_user_id: userId,
    p_dry_run: dryRun,
    p_previous_year_framework: input.previous_year_framework ?? null,
  })
  if (error) throw error
  const result = (data ?? {}) as RpcResult
  if (!result.ok) {
    const code = RPC_CODES[result.code ?? ''] ?? 'UNKNOWN_ERROR'
    throw codedRefusal(code, `The framework change was refused (${result.code ?? 'no code'}).`)
  }

  const changeResult: AccountingFrameworkChangeResult = {
    fiscal_period_id: fiscalPeriodId,
    framework: result.framework ?? input.framework,
    previous_framework: result.previous_framework ?? null,
    changed: Boolean(result.changed),
    k3_to_k2: Boolean(result.k3_to_k2),
    cascaded_period_ids: result.cascaded_period_ids ?? [],
    company_framework: result.company_framework ?? input.framework,
    dry_run: dryRun,
  }
  if (!dryRun && (changeResult.changed || changeResult.cascaded_period_ids.length > 0)) {
    await eventBus.emit({
      type: 'company.accounting_framework_changed',
      payload: {
        companyId,
        userId,
        fiscalPeriodId,
        framework: changeResult.framework,
        previousFramework: changeResult.previous_framework,
        cascadedPeriodIds: changeResult.cascaded_period_ids,
        k3ToK2: changeResult.k3_to_k2,
      },
    })
  }
  return changeResult
}
