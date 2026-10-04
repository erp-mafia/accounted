import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { filesIncomeReturn, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import { calculateEgenavgifter, type EgenavgiftCategory } from './egenavgifter-calculator'
import { calculateRantefordelning } from './rantefordelning-calculator'
import { proposeEfPfondAvsattning } from './periodiseringsfond-ef'
import { calculateExpansionsfondChange } from './expansionsfond-calculator'
import type { EfDeclarationItem } from './types'

export interface EfDeclarationPreviewInput {
  category?: EgenavgiftCategory
  /** Kapitalunderlag för räntefördelning: the previous year's closing
   *  balance (IL 33 kap 8 §). */
  kapitalunderlag?: number
  /** Kapitalunderlag för expansionsfond: this year's closing balance
   *  (IL 34 kap 7 §). A different date from the räntefördelning one, so it
   *  is never derived from it. */
  expansionsfondKapitalunderlag?: number
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
  /** NE R11 (bokfört resultat), whole kronor. */
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

  // The base is NE R11 (bokfört resultat), the figure the declaration starts
  // from. The operating income statement leaves out every year-end entry, so
  // booked avskrivningar and the kontantmetod cut-off would be missing from
  // the surplus.
  const neDeclaration = await generateNEDeclaration(supabase, companyId, fiscalPeriodId)
  const bookedSurplus = neDeclaration.rutor.R11
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

  // NE R33, the för periodiseringsfond justerade resultatet (IL 30 kap 6 §):
  // the result after räntefördelning (R30 deducted, R31 added) and before
  // any avdrag för egenavgifter, which comes later on the form (R40-R43) and
  // which 6 § adds back. R11 stands in for R29 because the NE engine has no
  // R12-R28 adjustments; no återföring (R32) is entered here.
  const rantefordelning = !r ? 0 : r.kind === 'rantefordelning_positive' ? -r.amount : r.amount
  const pfondBase = bookedSurplus + rantefordelning
  const pfond = proposeEfPfondAvsattning({
    surplus: pfondBase,
    fiscalYear,
    desiredAmount: input.pfondDesiredAmount,
  })
  if (pfond) items.push(pfond)

  if (input.expansionsfondDesiredChange && input.expansionsfondDesiredChange !== 0) {
    const exp = calculateExpansionsfondChange({
      kapitalunderlag: input.expansionsfondKapitalunderlag ?? 0,
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
