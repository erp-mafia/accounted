import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { filesIncomeReturn, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { calculateEgenavgifter, type EgenavgiftCategory } from './egenavgifter-calculator'
import { calculateRantefordelning } from './rantefordelning-calculator'
import { proposeEfPfondAvsattning } from './periodiseringsfond-ef'
import { calculateExpansionsfondChange } from './expansionsfond-calculator'
import type { EfDeclarationItem } from './types'

export interface EfDeclarationPreviewInput {
  category?: EgenavgiftCategory
  kapitalunderlag?: number
  priorYearSchablonavdrag?: number
  priorYearActualCharged?: number
  pfondDesiredAmount?: number
  expansionsfondExistingBalance?: number
  expansionsfondDesiredChange?: number
  /**
   * The company's legal form when the caller already resolved it (the
   * readiness aggregator); saves the companies read. Never a guess: an
   * invalid hint falls back to companies.entity_type.
   */
  entityType?: EntityType
}

/**
 * Egenavgifter, räntefördelning and the EF periodiseringsfond exist only for
 * a form that files NE-bilagan. Same shape as the NE engine's refusal
 * (lib/reports/ne-bilaga/ne-engine.ts), with a stable code so an MCP client
 * can dispatch on it instead of parsing prose.
 */
export class EfDeclarationNotApplicableError extends Error {
  readonly code = 'EF_DECLARATION_WRONG_LEGAL_FORM'
  constructor(readonly entityType: EntityType) {
    super(
      `EF declaration preview is only for a form that files NE-bilagan (enskild firma); this company is ${entityType}`,
    )
    this.name = 'EfDeclarationNotApplicableError'
  }
}

export interface EfDeclarationPreview {
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  bookedSurplus: number
  items: EfDeclarationItem[]
}

/**
 * Server-side mirror of the EfDeclarationSection client logic. The MCP tool
 * (Phase 7) calls this so agents can preview the same numbers without
 * round-tripping through the browser. Inputs default to "no adjustment"
 * which produces just the egenavgifter line.
 */
export async function computeEfDeclarationPreview(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  input: EfDeclarationPreviewInput = {},
): Promise<EfDeclarationPreview> {
  // Resolved before any other read, never defaulted: an aktiebolag or an
  // ideell förening has no egenavgifter and no NE-bilaga, so computing the
  // figures at all would hand an agent numbers that mean nothing for it.
  const form = await resolveCompanyEntityType(supabase, companyId, input.entityType)
  if (filesIncomeReturn(form) !== 'NE') throw new EfDeclarationNotApplicableError(form)

  const { data: period, error } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (error || !period) throw new Error('Fiscal period not found')

  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  const bookedSurplus = incomeStatement.net_result
  const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)

  const items: EfDeclarationItem[] = []

  const eg = calculateEgenavgifter({
    surplusBeforeEgenavgifter: bookedSurplus,
    category: input.category,
    priorYearSchablonavdrag: input.priorYearSchablonavdrag,
    priorYearActualCharged: input.priorYearActualCharged,
  })
  items.push(eg)

  const r = calculateRantefordelning({ kapitalunderlag: input.kapitalunderlag ?? 0 })
  if (r) items.push(r)

  const surplusAfterEg = bookedSurplus - eg.amount
  const pfond = proposeEfPfondAvsattning({
    surplus: surplusAfterEg,
    fiscalYear,
    desiredAmount: input.pfondDesiredAmount,
  })
  if (pfond) items.push(pfond)

  if (input.expansionsfondDesiredChange && input.expansionsfondDesiredChange !== 0) {
    const exp = calculateExpansionsfondChange({
      kapitalunderlag: input.kapitalunderlag ?? 0,
      existingBalance: input.expansionsfondExistingBalance,
      desiredChange: input.expansionsfondDesiredChange,
    })
    if (exp) items.push(exp)
  }

  return {
    fiscalPeriod: period,
    bookedSurplus,
    items,
  }
}
