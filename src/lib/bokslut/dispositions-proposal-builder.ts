import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveCompanyEntityType, supportsCorporateTaxDispositions } from '@/lib/company/entity-type'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { calculateBolagsskatt, getBookedBolagsskatt } from './tax-provision/bolagsskatt-calculator'
import { readYearResult, type YearResult } from './tax-provision/result-before-tax'
import { loadBuildingTaxAdjustment, loadTaxAdjustmentSnapshot } from './tax-provision/tax-adjustment-service'
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
import { buildDeferredTaxProposal, closingDeficitOf } from './tax-provision/deferred-tax-service'
import { buildDevelopmentFundProposal } from './development-fund'
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
  /** The year's result as the declaration reads it, posted dispositions in it. */
  result: YearResult
  taxAdjustments: TaxAdjustmentSnapshot
  /** Bolagsskatt already on 8910 (this flow's and any manual posting). */
  bookedTax: number
  existingFonder: ExistingFond[]
  /** INK2S 4.9: book depreciation on fast egendom against its tax plan. */
  buildingTaxAdjustment: number
}

export async function loadDispositionState(
  supabase: SupabaseClient,
  companyId: string,
  period: { id: string; period_start: string; period_end: string; opening_balance_entry_id: string | null },
  form?: EntityType,
): Promise<DispositionState> {
  const [result, taxAdjustments, bookedTax, existingFonder, buildingTax] = await Promise.all([
    readYearResult(supabase, companyId, period.id),
    loadTaxAdjustmentSnapshot(supabase, companyId, period.id, form),
    getBookedBolagsskatt(supabase, companyId, period.id),
    listExistingPeriodiseringsfonder(
      supabase,
      companyId,
      period.period_end,
      period.period_start,
      period.opening_balance_entry_id,
    ),
    loadBuildingTaxAdjustment(supabase, companyId, period),
  ])
  return {
    fiscalPeriodId: period.id,
    fiscalYear: parseInt(period.period_end.slice(0, 4), 10),
    result,
    taxAdjustments,
    bookedTax,
    existingFonder,
    buildingTaxAdjustment: Math.trunc(buildingTax.net),
  }
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
 * Cap base = skattemässigt resultat före avsättning: resultat före skatt, with
 * every posted disposition in it (a posted avsättning added back: its headroom
 * effect is alreadyProvisioned), plus `pendingResultEffect` (the result effect
 * of the dispositions proposed before this one but not yet posted: återföring,
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
    state.result.beforeTax + alreadyProvisioned + options.pendingResultEffect
    + options.schablonintaktAmount
    + taxAdjustments.nonDeductibleExpenses - taxAdjustments.nonTaxableIncome
    + state.buildingTaxAdjustment
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
 * state.result, `pendingResultEffect` carries those proposed but not yet
 * posted (+ återföring, + överavskrivningar effect, − avsättning, − SLP).
 */
export function bolagsskattDisposition(
  state: DispositionState,
  options: { pendingResultEffect: number; schablonintaktAmount: number },
): ProposedDisposition {
  return calculateBolagsskatt({
    resultBeforeTax: state.result.beforeTax + options.pendingResultEffect,
    manualAdjustments: {
      nonDeductibleExpenses: state.taxAdjustments.nonDeductibleExpenses,
      nonTaxableIncome: state.taxAdjustments.nonTaxableIncome,
      deficitCarryforward: state.taxAdjustments.deficitCarryforward ?? 0,
      schablonintaktPeriodiseringsfond: options.schablonintaktAmount,
      // INK2S 4.9, the same figure the declaration files.
      other: state.buildingTaxAdjustment,
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
  // bokslut run) are in the year's result, and the effect of the ones proposed
  // here but not posted yet goes in as pendingResultEffect, so a re-visit
  // previews the same amounts the POST books (it calls the same functions
  // after posting each item).
  const state = await loadDispositionState(supabase, companyId, period, form)
  const { taxAdjustments, bookedTax } = state

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

  // SLP already booked is the calculator's: it proposes the remainder only.
  const slp = await calculateSarskildLoneskatt(supabase, companyId, fiscalPeriodId)

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
  const bolagsskatt = bolagsskattDisposition(state, {
    pendingResultEffect:
      ateforingTotal + overavskrivningarResultEffect - (avsattning?.amount ?? 0) - (slp?.amount ?? 0),
    schablonintaktAmount: ateforing.schablonintaktAmount,
  })
  if (bookedTax > 0) {
    const expectedTax = bolagsskatt.amount
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
  } else if (bolagsskatt.amount > 0) {
    proposals.push(bolagsskatt)
  }

  // Uppskjuten skatt last, in a K3 year: it is not part of the tax base
  // (8940 is income tax: added back with 8900-8989 when booked by hand, and
  // this flow's own posting is year_end, outside the result), and the loss
  // carried forward it may recognise is the bolagsskatt computation's
  // closing underskott.
  const deferred = await buildDeferredTaxProposal(supabase, companyId, fiscalPeriodId, {
    closingDeficit: closingDeficitOf(bolagsskatt),
  })
  if (deferred?.proposal) proposals.push(deferred.proposal)
  if (deferred?.snapshot.needsInputs) {
    warnings.push(
      `Bokföringen har uppskjuten skatt (netto ${deferred.snapshot.opening} kr på 2240 och 1370) men inget underlag för uppskjuten skatt är sparat för året. Ingen uppskjuten skatt föreslås förrän underlaget är sparat, så att saldot inte återförs mot 8940 av misstag (K3 kap. 29).`,
    )
  }

  // The fond för utvecklingsutgifter (K3, ÅRL 4 kap. 2 §): an equity
  // transfer, no effect on any figure above.
  const fund = await buildDevelopmentFundProposal(supabase, companyId, fiscalPeriodId, form)
  if (fund?.warning) warnings.push(fund.warning)
  if (fund?.proposal) proposals.push(fund.proposal)

  return {
    entityType,
    fiscalPeriod: period,
    netResultBefore: state.result.beforeDispositions,
    proposals,
    taxAdjustments,
    completedDispositions,
    warnings,
    ...(deferred ? { deferredTax: deferred.snapshot } : {}),
  }
}

