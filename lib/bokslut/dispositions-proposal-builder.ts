import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import {
  calculateBolagsskatt,
  getBookedBolagsskatt,
  sumPostedYearEndDispositions,
} from './tax-provision/bolagsskatt-calculator'
import { loadTaxAdjustmentSnapshot } from './tax-provision/tax-adjustment-service'
import { calculateSarskildLoneskatt } from './tax-provision/sarskild-loneskatt-calculator'
import {
  computeLatentTax,
  LATENT_TAX_EXPENSE_ACCOUNT,
  LATENT_TAX_LIABILITY_ACCOUNT,
  proposeLatentTaxChange,
} from './tax-provision/latent-tax-calculator'
import {
  getPeriodiseringsfondCohortAccount,
  getSchablonintaktRate,
  listExistingPeriodiseringsfonder,
  proposeAvsattning,
  proposeAteforing,
} from './reserves/periodiseringsfond-service'
import { calculateOveravskrivningar } from './reserves/overavskrivningar-calculator'
import type { CompletedDisposition, DispositionsProposal, ProposedDisposition } from './types'
import type { AccountingFramework } from '@/types'

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
  const entityType = (settings?.entity_type ?? 'aktiebolag') as DispositionsProposal['entityType']

  if (entityType !== 'aktiebolag') {
    // Non-AB entities (enskild firma, handelsbolag, etc.) do not produce
    // bookable bokslutsdispositioner: bolagsskatt, periodiseringsfond and
    // SLP are AB-only mechanisms. EF tax mechanisms (egenavgifter,
    // räntefördelning, periodiseringsfond-EF, expansionsfond) are
    // declaration-only and surface through the dedicated
    // /api/bookkeeping/fiscal-periods/[id]/ef-declaration endpoint and the
    // EfDeclarationSection in the wizard: they never produce journal
    // entries, so they have no place in this list.
    const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
    return {
      entityType,
      fiscalPeriod: period,
      netResultBefore: incomeStatement.net_result,
      proposals: [],
    }
  }

  // Look up the accounting framework: K3 (BFNAR 2012:1) triggers the
  // uppskjuten-skatt provision step; K2 skips it.
  const { data: companyRow } = await supabase
    .from('companies')
    .select('accounting_framework')
    .eq('id', companyId)
    .maybeSingle()
  const accountingFramework: AccountingFramework =
    (companyRow as { accounting_framework?: AccountingFramework } | null)?.accounting_framework
      === 'k3'
      ? 'k3'
      : 'k2'

  const fiscalYear = parseInt(period.period_end.slice(0, 4), 10)
  const incomeStatement = await generateIncomeStatement(supabase, companyId, fiscalPeriodId)
  const resultBeforeTax = incomeStatement.net_result

  const proposals: ProposedDisposition[] = []
  const completedDispositions: CompletedDisposition[] = []
  const warnings: string[] = []

  // Dispositions already POSTED in this period (a partially completed
  // bokslut run) are excluded from resultBeforeTax like all year_end
  // entries, but they do affect the taxable base: their signed P&L effect
  // is folded into every base below so a re-visit previews the same
  // amounts the commit path books.
  const postedEffect = await sumPostedYearEndDispositions(
    supabase,
    companyId,
    fiscalPeriodId,
  )
  const [taxAdjustments, bookedTax] = await Promise.all([
    loadTaxAdjustmentSnapshot(supabase, companyId, fiscalPeriodId),
    getBookedBolagsskatt(supabase, companyId, fiscalPeriodId),
  ])
  // Income statement excludes tax posted by this year-end flow, but includes
  // manually posted 8910. Add back only the latter to get a stable pre-tax
  // result on reload.
  const manuallyBookedTax = Math.max(0, bookedTax - postedEffect.taxProvisionPortion)
  const normalizedResultBeforeTax = resultBeforeTax + manuallyBookedTax

  const existingFonder = await listExistingPeriodiseringsfonder(
    supabase,
    companyId,
    period.period_end,
    period.period_start,
    period.opening_balance_entry_id,
  )
  const ateforing = proposeAteforing(existingFonder, {
    schablonintaktRate: getSchablonintaktRate(fiscalYear),
  })
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
  // avsättning and lets the user book it twice. Measured as the current
  // cohort ACCOUNT's growth during the period (closing minus opening), so a
  // prior-year fond that happens to share the account (shortened brutet
  // räkenskapsår, decade wrap) does not consume this year's headroom.
  const currentCohort = existingFonder.find(
    (f) => f.account_number === getPeriodiseringsfondCohortAccount(fiscalYear),
  )
  const alreadyProvisioned = currentCohort
    ? Math.max(0, currentCohort.balance - Math.max(0, currentCohort.opening_balance))
    : 0

  // Cap base = skattemässigt resultat före avsättning: ledger result plus
  // posted dispositions (with any posted avsättning added back: its
  // headroom effect is alreadyProvisioned, not a base reduction), plus
  // proposed återföringar and schablonintäkt, minus deductible SLP.
  const taxableBeforeAvsattning =
    normalizedResultBeforeTax + postedEffect.total + alreadyProvisioned + ateforingTotal
    + overavskrivningarResultEffect
    + ateforing.schablonintaktAmount - (slp?.amount ?? 0)
    + taxAdjustments.nonDeductibleExpenses - taxAdjustments.nonTaxableIncome
  const avsattning = alreadyProvisioned > 0
    ? null
    : proposeAvsattning({
        skattemassigtResultatBeforeAvsattning: taxableBeforeAvsattning,
        fiscalYear,
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
  // In preview mode nothing is posted yet, so the income statement still shows
  // the pre-disposition result: we mirror each proposal's effect on resultat
  // före skatt and hand the post-disposition base to the calculator:
  //   + återföring (8819, intäkt)
  //   − avsättning (8811, kostnad)
  //   − SLP        (7533, kostnad)
  // Without this, the previewed tax ignores the avsättning (tax too high) and
  // diverges from what the sequential commit books and from ÅR/INK2.
  const resultAfterDispositions =
    normalizedResultBeforeTax + postedEffect.total + ateforingTotal
    + overavskrivningarResultEffect
    - (avsattning?.amount ?? 0) - (slp?.amount ?? 0)

  const bolagsskatt = await calculateBolagsskatt(supabase, companyId, fiscalPeriodId, {
    resultBeforeTaxOverride: resultAfterDispositions,
    manualAdjustments: {
      nonDeductibleExpenses: taxAdjustments.nonDeductibleExpenses,
      nonTaxableIncome: taxAdjustments.nonTaxableIncome,
      schablonintaktPeriodiseringsfond: ateforing.schablonintaktAmount,
    },
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

  // K3 only: split obeskattade reserver into the 79.4 % equity portion and
  // the 20.6 % uppskjuten skatteskuld. We sum the projected 21xx balance
  // AFTER the dispositions above have been applied so the latent-tax
  // amount reflects the closing position: anything else would diverge
  // from the BR the user sees in the preview.
  if (accountingFramework === 'k3') {
    const latentTax = await buildLatentTaxProposal({
      supabase,
      companyId,
      fiscalPeriodId,
      proposalsBeforeLatentTax: proposals,
    })
    if (latentTax) proposals.push(latentTax)
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

/**
 * Compose the K3 uppskjuten-skatt proposal.
 *
 * The latent tax provision must reflect the *closing* obeskattade-reserver
 * balance, so we pull the current 21xx balance from the trial balance and
 * adjust it for any 21xx-touching dispositions that haven't yet posted
 * (avsättning ↑, återföring ↓). 2240's current balance is the existing
 * provision; the delta becomes the new verifikat.
 */
export async function buildLatentTaxProposal(params: {
  supabase: SupabaseClient
  companyId: string
  fiscalPeriodId: string
  /** Optional: additional 21xx-touching dispositions that have NOT yet been
   *  posted but will be in the same batch. The TB already reflects everything
   *  posted, so leave this empty if the latent-tax run is sequenced after the
   *  21xx postings (the API route's case). */
  proposalsBeforeLatentTax?: ProposedDisposition[]
}): Promise<ProposedDisposition | null> {
  const { supabase, companyId, fiscalPeriodId, proposalsBeforeLatentTax = [] } = params

  // Reads 21xx and 2240 only (class 2), which no resultatavslut touches.
  const tb = await generateTrialBalance(supabase, companyId, fiscalPeriodId, {
    closingEntry: 'include',
  })

  // 21xx: obeskattade reserver (credit-normal, so we measure credit − debit).
  let untaxedReserves = tb.rows
    .filter((r) => r.account_number.startsWith('21'))
    .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)

  // Pending 21xx postings from the proposals that will commit alongside
  // latent tax. Credits add to reserves and debits remove them.
  for (const p of proposalsBeforeLatentTax) {
    for (const line of p.lines) {
      if (!line.account_number.startsWith('21')) continue
      untaxedReserves += (line.credit_amount ?? 0) - (line.debit_amount ?? 0)
    }
  }

  // Current 2240 balance: credit-normal. Equal to existing latent tax.
  const current2240 = tb.rows
    .filter((r) => r.account_number === LATENT_TAX_LIABILITY_ACCOUNT)
    .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)

  const split = computeLatentTax({ untaxedReserves })
  const lines = proposeLatentTaxChange(current2240, split.liabilityPortion)
  if (!lines) return null

  const delta = Math.round((split.liabilityPortion - current2240) * 100) / 100
  const amount = Math.abs(delta)
  const direction = delta > 0 ? 'avsättning' : 'återföring'

  return {
    kind: 'uppskjuten_skatt',
    label: 'Uppskjuten skatt (K3)',
    description:
      delta > 0
        ? `Avsättning till uppskjuten skatteskuld 20,6 % av obeskattade reserver. Debet ${LATENT_TAX_EXPENSE_ACCOUNT}, kredit ${LATENT_TAX_LIABILITY_ACCOUNT}.`
        : `Återföring av uppskjuten skatteskuld när obeskattade reserver minskar. Debet ${LATENT_TAX_LIABILITY_ACCOUNT}, kredit ${LATENT_TAX_EXPENSE_ACCOUNT}.`,
    amount,
    lines,
    warnings: [],
    computation: {
      untaxedReserves,
      taxRate: 0.206,
      target2240: split.liabilityPortion,
      current2240,
      delta,
      direction,
      equityPortion: split.equityPortion,
    },
  }
}
