import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType, supportsCorporateTaxDispositions } from '@/lib/company/entity-type'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import {
  calculateBolagsskatt,
  getBookedBolagsskatt,
  sumPostedYearEndDispositions,
} from './tax-provision/bolagsskatt-calculator'
import { loadTaxAdjustmentSnapshot } from './tax-provision/tax-adjustment-service'
import type { TaxAdjustmentSnapshot } from './types'
import { calculateSarskildLoneskatt } from './tax-provision/sarskild-loneskatt-calculator'
import {
  getPeriodiseringsfondCohortAccount,
  listExistingPeriodiseringsfonder,
  proposeAvsattning,
  proposeAteforing,
  resolveSchablonintaktRate,
  type ExistingFond,
} from './reserves/periodiseringsfond-service'
import { calculateOveravskrivningar } from './reserves/overavskrivningar-calculator'
import type { CompletedDisposition, DispositionsProposal, ProposedDisposition } from './types'
import type { EntityType } from '@/types'

/**
 * What every disposition's amount is computed from, read from the ledger.
 * The GET preview reads it once; the POST re-reads it before each item,
 * because each item it books moves the next one's base.
 */
export interface DispositionState {
  fiscalPeriodId: string
  fiscalYear: number
  /** The income statement's result: source_type year_end excluded. */
  netResult: number
  /** Dispositions already posted in this period (sumPostedYearEndDispositions). */
  postedEffect: Awaited<ReturnType<typeof sumPostedYearEndDispositions>>
  taxAdjustments: TaxAdjustmentSnapshot
  /** Bolagsskatt already on 8910 (this flow's and any manual posting). */
  bookedTax: number
  existingFonder: ExistingFond[]
}

export async function loadDispositionState(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_start: string; period_end: string; opening_balance_entry_id: string | null },
  form?: EntityType,
): Promise<DispositionState> {
  const [incomeStatement, postedEffect, taxAdjustments, bookedTax, existingFonder] = await Promise.all([
    generateIncomeStatement(supabase, companyId, period.id),
    sumPostedYearEndDispositions(supabase, companyId, period.id),
    loadTaxAdjustmentSnapshot(supabase, companyId, period.id, form),
    getBookedBolagsskatt(supabase, companyId, period.id),
    listExistingPeriodiseringsfonder(
      supabase,
      companyId,
      period.period_end,
      period.period_start,
      period.opening_balance_entry_id,
    ),
  ])
  return {
    fiscalPeriodId: period.id,
    fiscalYear: parseInt(period.period_end.slice(0, 4), 10),
    netResult: incomeStatement.net_result,
    postedEffect,
    taxAdjustments,
    bookedTax,
    existingFonder,
  }
}

/**
 * Resultat före skatt, stable on reload: the income statement excludes the tax
 * this flow posts but includes a manually posted 8910, so the latter is added
 * back.
 */
export function resultBeforeTax(state: DispositionState): number {
  return state.netResult + Math.max(0, state.bookedTax - state.postedEffect.taxProvisionPortion)
}

/** The återföringar (and the schablonintäkt on the fonder's opening balance). */
export function ateforingDispositions(
  state: DispositionState,
  options: { returns?: Record<string, number>; schablonintaktRate?: number } = {},
) {
  return proposeAteforing(state.existingFonder, {
    returns: options.returns,
    schablonintaktRate: resolveSchablonintaktRate(state.fiscalYear, state.existingFonder, options.schablonintaktRate),
  })
}

/** This year's avsättning already booked on its cohort account (it consumes the 25 % cap). */
export function alreadyProvisionedAvsattning(state: DispositionState): number {
  const currentCohort = state.existingFonder.find(
    (f) => f.account_number === getPeriodiseringsfondCohortAccount(state.fiscalYear),
  )
  return currentCohort ? Math.max(0, currentCohort.balance - Math.max(0, currentCohort.opening_balance)) : 0
}

/**
 * The avsättning to periodiseringsfond, or null when this year's avsättning
 * is already booked (a completed decision, never topped up on reload).
 *
 * Cap base = skattemässigt resultat före avsättning: resultat före skatt plus
 * the posted dispositions (a posted avsättning added back: its headroom effect
 * is alreadyProvisioned), plus `pendingResultEffect` (the result effect of the
 * dispositions proposed before this one but not yet posted: återföring,
 * överavskrivningar, SLP), plus schablonintäkt and the tax adjustments.
 */
export function avsattningDisposition(
  state: DispositionState,
  options: { pendingResultEffect: number; schablonintaktAmount: number; desiredAmount?: number },
): ProposedDisposition | null {
  const alreadyProvisioned = alreadyProvisionedAvsattning(state)
  if (alreadyProvisioned > 0) return null
  const { taxAdjustments } = state
  const base =
    resultBeforeTax(state) + state.postedEffect.total + alreadyProvisioned + options.pendingResultEffect
    + options.schablonintaktAmount
    + taxAdjustments.nonDeductibleExpenses - taxAdjustments.nonTaxableIncome
    - (taxAdjustments.deficitCarryforward ?? 0)
  return proposeAvsattning({
    skattemassigtResultatBeforeAvsattning: base,
    desiredAmount: options.desiredAmount,
    fiscalYear: state.fiscalYear,
    alreadyProvisioned,
  })
}

/**
 * Bolagsskatt on the result AFTER every disposition: the posted ones are in
 * postedEffect, `pendingResultEffect` carries those proposed but not yet
 * posted (+ återföring, + överavskrivningar effect, − avsättning, − SLP).
 */
export async function bolagsskattDisposition(
  supabase: SupabaseClient,
  companyId: string,
  state: DispositionState,
  options: { pendingResultEffect: number; schablonintaktAmount: number },
): Promise<ProposedDisposition | null> {
  return calculateBolagsskatt(supabase, companyId, state.fiscalPeriodId, {
    resultBeforeTaxOverride: resultBeforeTax(state) + state.postedEffect.total + options.pendingResultEffect,
    manualAdjustments: {
      nonDeductibleExpenses: state.taxAdjustments.nonDeductibleExpenses,
      nonTaxableIncome: state.taxAdjustments.nonTaxableIncome,
      deficitCarryforward: state.taxAdjustments.deficitCarryforward ?? 0,
      schablonintaktPeriodiseringsfond: options.schablonintaktAmount,
    },
  })
}

/**
 * Shared core of the GET /bokslutsdispositioner endpoint, lifted out so the
 * MCP tool can call the same builder without duplicating the proposal logic.
 * The API route and the MCP tool both hand its output to the caller, who
 * picks which proposals to commit via the POST endpoint.
 */
export async function buildDispositionsProposal(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
): Promise<DispositionsProposal> {
  const { data: period, error: periodError } = await supabase
    .from('fiscal_periods')
    .select('id, name, period_start, period_end, opening_balance_entry_id')
    .eq('id', fiscalPeriodId)
    .eq('company_id', companyId)
    .single()
  if (periodError || !period) {
    throw new Error('Fiscal period not found')
  }

  const { data: settings } = await supabase
    .from('company_settings')
    .select('entity_type')
    .eq('company_id', companyId)
    .maybeSingle()
  const form = await resolveCompanyEntityType(supabase, companyId, settings?.entity_type)
  const entityType: DispositionsProposal['entityType'] = form

  if (!supportsCorporateTaxDispositions(form)) {
    // A form without corporate tax dispositions (enskild firma, ideell
    // förening) produces no bookable bokslutsdispositioner: bolagsskatt,
    // periodiseringsfond and SLP are mechanisms of the forms whose profile
    // says so. EF tax mechanisms (egenavgifter, räntefördelning,
    // periodiseringsfond-EF, expansionsfond) are declaration-only and
    // surface through the EfDeclarationSection in the wizard: they never
    // produce journal entries, so they have no place in this list.
    const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
    return {
      entityType,
      fiscalPeriod: period,
      netResultBefore: incomeStatement.net_result,
      proposals: [],
    }
  }

  const proposals: ProposedDisposition[] = []
  const completedDispositions: CompletedDisposition[] = []
  const warnings: string[] = []

  // Dispositions already POSTED in this period (a partially completed
  // bokslut run) are excluded from the income statement like all year_end
  // entries, but they do affect the taxable base: the per-kind functions fold
  // their signed P&L effect in, and the effect of the ones proposed here but
  // not posted yet goes in as pendingResultEffect, so a re-visit previews the
  // same amounts the POST books (it calls the same functions after posting
  // each item).
  const state = await loadDispositionState(supabase, companyId, period, form)
  const { postedEffect, taxAdjustments, bookedTax } = state
  const normalizedResultBeforeTax = resultBeforeTax(state)

  // Rate resolves lazily: a company without opening fonder never touches
  // the SLR table, so an unmapped year cannot break its bokslut.
  const ateforing = ateforingDispositions(state)
  proposals.push(...ateforing.proposals)
  const ateforingTotal = ateforing.proposals.reduce((sum, p) => sum + p.amount, 0)

  const overavskrivningar = await calculateOveravskrivningar({
    supabase,
    companyId,
    fiscalPeriod: period,
    entityType,
  })
  if (overavskrivningar.warning) warnings.push(overavskrivningar.warning)
  if (overavskrivningar.proposal) proposals.push(overavskrivningar.proposal)
  if (
    !overavskrivningar.proposal
    && overavskrivningar.status === 'ready'
    && Math.abs(overavskrivningar.currentPeriodChange) >= 0.01
  ) {
    completedDispositions.push({
      kind: 'overavskrivningar',
      label: 'Förändring av överavskrivningar',
      amount: Math.abs(overavskrivningar.currentPeriodChange),
      status: 'booked',
      warnings: [],
    })
  }
  const overavskrivningarResultEffect = -(
    overavskrivningar.proposal?.signedAmount ?? 0
  )

  // SLP already posted in this period (resumed run): don't re-propose it
  // (that would book it twice) and don't subtract it twice below (its
  // effect is already inside postedEffect.total).
  const slp =
    postedEffect.slpPortion !== 0
      ? null
      : await calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId)

  // An avsättning already booked in this bokslut eats into the 25 % cap;
  // without this, revisiting the page after committing re-proposes the full
  // avsättning and lets the user book it twice.
  const alreadyProvisioned = alreadyProvisionedAvsattning(state)
  const avsattning = avsattningDisposition(state, {
    pendingResultEffect: ateforingTotal + overavskrivningarResultEffect - (slp?.amount ?? 0),
    schablonintaktAmount: ateforing.schablonintaktAmount,
  })
  if (avsattning) proposals.push(avsattning)
  if (alreadyProvisioned > 0) {
    completedDispositions.push({
      kind: 'periodiseringsfond_avsattning',
      label: 'Avsättning till periodiseringsfond',
      amount: alreadyProvisioned,
      status: 'booked',
      warnings: [],
    })
  }

  if (slp) proposals.push(slp)

  // Bolagsskatt must be computed on the result AFTER the dispositions above.
  // In preview mode nothing is posted yet, so each proposal's effect on
  // resultat före skatt goes in as pending:
  //   + återföring (8819, intäkt)
  //   − avsättning (8811, kostnad)
  //   − SLP        (7533, kostnad)
  // Without this, the previewed tax ignores the avsättning (tax too high) and
  // diverges from what the sequential commit books and from ÅR/INK2.
  const bolagsskatt = await bolagsskattDisposition(supabase, companyId, state, {
    pendingResultEffect:
      ateforingTotal + overavskrivningarResultEffect - (avsattning?.amount ?? 0) - (slp?.amount ?? 0),
    schablonintaktAmount: ateforing.schablonintaktAmount,
  })
  if (bookedTax > 0) {
    const expectedTax = bolagsskatt?.amount ?? 0
    const matches = bookedTax === expectedTax
    completedDispositions.push({
      kind: 'bolagsskatt',
      label: 'Bolagsskatt 20,6 %',
      amount: bookedTax,
      status: matches ? 'booked' : 'needs_correction',
      warnings: matches
        ? []
        : [
            `Bokförd skatt är ${bookedTax} kr, men aktuellt underlag ger ${expectedTax} kr. Rätta den bokförda skatten innan bokslutet verkställs.`,
          ],
    })
  } else if (bolagsskatt && bolagsskatt.amount > 0) {
    proposals.push(bolagsskatt)
  }

  return {
    entityType,
    fiscalPeriod: period,
    netResultBefore: normalizedResultBeforeTax,
    proposals,
    taxAdjustments,
    completedDispositions,
    warnings,
  }
}

