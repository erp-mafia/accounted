import type { SupabaseClient } from '@supabase/supabase-js'
import type { EntityType } from '@/types'
import { filesIncomeReturn, resolveCompanyEntityType } from '@/lib/company/entity-type'
import { generateNEDeclaration } from '@/lib/reports/ne-bilaga/ne-engine'
import { calculateEgenavgifter, type EgenavgiftCategory } from './egenavgifter-calculator'
import { calculateRantefordelning } from './rantefordelning-calculator'
import { truncateToWholeKronor } from '@/lib/money'
import {
  classifyEfPfonder,
  proposeEfPfondAteforing,
  proposeEfPfondAvsattning,
  type EfExistingFond,
  type EfFondState,
} from './periodiseringsfond-ef'
import { calculateExpansionsfondChange } from './expansionsfond-calculator'
import type { EfDeclarationItem, EfNeRutor, EfOvrigUppgift } from './types'

export interface EfDeclarationPreviewInput {
  category?: EgenavgiftCategory
  /** Kapitalunderlag för räntefördelning: the previous year's closing
   *  balance (IL 33 kap), as on hjälpblankett SKV 2196, the addition of
   *  sparat fördelningsbelopp included. */
  kapitalunderlag?: number
  /** Sparat fördelningsbelopp from earlier years (last year's NE, Övriga
   *  uppgifter). Used directly in R30 on top of this year's
   *  fördelningsbelopp; it is already part of the kapitalunderlag. */
  sparatFordelningsbelopp?: number
  /** Kapitalunderlag för expansionsfond: this year's closing balance
   *  (IL 34 kap). A different date from the räntefördelning one, so it
   *  is never derived from it. */
  expansionsfondKapitalunderlag?: number
  priorYearSchablonavdrag?: number
  priorYearActualCharged?: number
  pfondDesiredAmount?: number
  /**
   * Periodiseringsfonder from earlier years (NE R34 of each year), one per
   * avsättningsår. An enskild firma never books them (K1), so the books
   * cannot give them: the owner enters them, like the expansionsfond
   * balance. The fund in its sixth year after the avsättning is återförd.
   */
  pfondExistingFonder?: EfExistingFond[]
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

export interface EfDeclarationFigures {
  /** The cards, in the order of the form: R30/R31, R32, R34, R36/R37, R43. */
  items: EfDeclarationItem[]
  /**
   * Every earlier fund the caller entered, oldest first, with its last year
   * and whether it returns now. Only `mandatory` and `overdue` funds are in
   * `items`; an `optional` one stays unless the owner chooses otherwise.
   */
  pfondFonder: EfFondState[]
  /** NE-bilaga sida 2 from R29 to R43, whole kronor. */
  rutor: EfNeRutor
  /** The Övriga uppgifter the form asks for in this case (its footnotes 4 and 5). */
  ovrigaUppgifter: EfOvrigUppgift[]
  /** What the figures leave out, for the owner to check. */
  warnings: string[]
}

export interface EfDeclarationPreview extends EfDeclarationFigures {
  fiscalPeriod: {
    id: string
    name: string
    period_start: string
    period_end: string
  }
  /** NE R11 (bokfört resultat), whole kronor. */
  bookedSurplus: number
}

/**
 * The NE engine has no R12-R28 adjustments, so R29 is the booked result.
 * Said on every preview: the owner is the one who knows whether they have
 * such adjustments, and every figure after R29 moves with them.
 */
export const R29_FROM_BOOKED_RESULT =
  'R29 utgår från bokfört resultat (R11): skattemässiga justeringar i R13-R28, till exempel ej avdragsgill representation eller underskott från förra året, är inte med. Har du sådana ändras R29 och alla belopp efter den.'

function listYears(years: number[]): string {
  if (years.length <= 1) return years.join('')
  return `${years.slice(0, -1).join(', ')} och ${years[years.length - 1]}`
}

/**
 * The återföring that cannot wait, as the one NE R32 figure it is on the
 * form, naming every fund year in it.
 */
function mandatoryAteforing(fonder: EfExistingFond[], fiscalYear: number): EfDeclarationItem | null {
  const perFund = proposeEfPfondAteforing({ existingFonder: fonder, closingYear: fiscalYear })
  if (perFund.length === 0) return null
  const years = perFund.map((item) => item.computation.cohort_year as number)
  const amount = truncateToWholeKronor(perFund.reduce((sum, item) => sum + item.amount, 0))
  return {
    kind: 'periodiseringsfond_ateforing',
    label: `${years.length === 1 ? 'Periodiseringsfond' : 'Periodiseringsfonder'} ${listYears(years)}: återföring`,
    description:
      'Måste återföras i år, senast det sjätte året efter avsättningen. Fylls i i NE-bilaga R32 och ökar överskottet före årets avsättning (R33). Bokförs inte.',
    amount,
    ne_ruta: 'R32',
    computation: { cohorts: perFund.map((item) => item.computation), total: amount },
    warnings: perFund.flatMap((item) => item.warnings),
  }
}

/**
 * NE-bilaga sida 2 from the booked result, in the form's order: each sum is
 * defined once here and each deduction by its calculator, from the sum the
 * form caps it at.
 *
 *   R29 = R11 (no R12-R28 adjustments)
 *   R30/R31 räntefördelning, R30 at most R29
 *   R32 återföring of earlier periodiseringsfonder
 *   R33 = R29 - R30 + R31 + R32; R34 at most 30 % of R33
 *   R35 = R33 - R34; R36 at most R35 and the 125,94 % room, R37 minskning
 *   R42 = R35 - R36 + R37 - R38 - R39 + R40 - R41; R43 a schablon of R42
 */
export function buildEfDeclarationFigures(
  bookedSurplus: number,
  period: { period_start: string; period_end: string },
  input: EfDeclarationPreviewInput = {},
): EfDeclarationFigures {
  const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)
  const warnings = [R29_FROM_BOOKED_RESULT]
  const items: EfDeclarationItem[] = []

  const r29 = truncateToWholeKronor(bookedSurplus)

  const rantefordelning = calculateRantefordelning({
    kapitalunderlag: input.kapitalunderlag ?? 0,
    sparatFordelningsbelopp: input.sparatFordelningsbelopp,
    resultBeforeRantefordelning: r29,
    periodStart: period.period_start,
    periodEnd: period.period_end,
  })
  items.push(...rantefordelning.items)
  warnings.push(...rantefordelning.warnings)
  const { r30, r31 } = rantefordelning

  // Funds in or past their sixth year return now, oldest first.
  const fonder = input.pfondExistingFonder ?? []
  const ateforing = mandatoryAteforing(fonder, fiscalYear)
  if (ateforing) items.push(ateforing)
  const r32 = ateforing?.amount ?? 0

  // R33, the för periodiseringsfond justerade resultatet (IL 30 kap 6 §):
  // before any avdrag för egenavgifter, which comes later on the form
  // (R40-R43) and which 6 § adds back.
  const r33 = r29 - r30 + r31 + r32
  const pfond = proposeEfPfondAvsattning({
    surplus: r33,
    fiscalYear,
    desiredAmount: input.pfondDesiredAmount,
  })
  if (pfond) items.push(pfond)
  const r34 = pfond?.amount ?? 0

  const r35 = r33 - r34
  const expansionsfond = calculateExpansionsfondChange({
    kapitalunderlag: input.expansionsfondKapitalunderlag,
    existingBalance: input.expansionsfondExistingBalance,
    desiredChange: input.expansionsfondDesiredChange,
    resultBeforeExpansionsfond: r35,
  })
  if (expansionsfond.item) items.push(expansionsfond.item)
  const { r36, r37 } = expansionsfond

  const r40 = Math.max(0, truncateToWholeKronor(input.priorYearSchablonavdrag ?? 0))
  const r41 = truncateToWholeKronor(input.priorYearActualCharged ?? 0)
  const r42 = r35 - r36 + r37 + r40 - r41
  const egenavgifter = calculateEgenavgifter({ surplusBeforeEgenavgifter: r42, category: input.category })
  items.push(egenavgifter)
  const r43 = egenavgifter.amount

  const ovrigaUppgifter: EfOvrigUppgift[] = []
  const kapitalunderlag = truncateToWholeKronor(input.kapitalunderlag ?? 0)
  if (rantefordelning.kapitalunderlagRequired && kapitalunderlag > 0) {
    ovrigaUppgifter.push({ faltkod: '8009', label: 'Kapitalunderlag för räntefördelning (positivt)', amount: kapitalunderlag })
  }
  if (rantefordelning.kapitalunderlagRequired && kapitalunderlag < 0) {
    ovrigaUppgifter.push({ faltkod: '8010', label: 'Kapitalunderlag för räntefördelning (negativt)', amount: -kapitalunderlag })
  }
  if (rantefordelning.sparatTillNastaAr > 0) {
    ovrigaUppgifter.push({
      faltkod: '8011',
      label: 'Positivt fördelningsbelopp som sparas till nästa beskattningsår',
      amount: rantefordelning.sparatTillNastaAr,
    })
  }
  // Footnote 5: given by one who has an expansionsfond left at year-end.
  if (expansionsfond.newBalance > 0 && input.expansionsfondKapitalunderlag !== undefined) {
    ovrigaUppgifter.push({
      faltkod: '8012',
      label: 'Kapitalunderlag expansionsfond (positivt)',
      amount: Math.max(0, truncateToWholeKronor(input.expansionsfondKapitalunderlag)),
    })
  }

  return {
    items,
    pfondFonder: classifyEfPfonder(fonder, fiscalYear),
    rutor: { R29: r29, R30: r30, R31: r31, R32: r32, R33: r33, R34: r34, R35: r35, R36: r36, R37: r37, R40: r40, R41: r41, R42: r42, R43: r43 },
    ovrigaUppgifter,
    warnings,
  }
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

  return {
    fiscalPeriod: period,
    bookedSurplus,
    ...buildEfDeclarationFigures(bookedSurplus, period, input),
  }
}
