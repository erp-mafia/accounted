import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchTrialBalanceChart, generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { CashFlowTaxAllocationError } from '@/lib/reports/cash-flow-tax'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { registerWriteDownsByAccount, writeDownMovement } from '@/lib/bokslut/assets/value-adjustments'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { LATENT_TAX_DEFAULT_RATE } from '@/lib/bokslut/tax-provision/latent-tax-calculator'
import type { DeferredTaxMovement } from '@/lib/bokslut/tax-provision/deferred-tax-service'
import { roundOre } from '@/lib/money'
import { pickPreviousFiscalPeriod } from '@/lib/core/bookkeeping/period-service'
import {
  K2_BR_MAPPINGS,
  k2BrPostForAccount,
  k2LegalFormOf,
  mapTrialBalancesToK2,
  type K2LegalForm,
  type K2MappingResult,
  type TrialBalancePair,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import { k2AssetPostLabel } from '@/lib/bokslut/ixbrl/document/statements'
import { buildBrRows, buildRrRows } from './statement-rows'
import { getNarrative, listFixedAssetNoteRows, type NarrativeRow } from './narrative-service'
import { loadRegisterNoteTexts } from '@/lib/commitments/disclosures'
import {
  effectiveDisclosureTexts,
  registerOverrideWarnings,
  type RegisterDisclosureTexts,
} from './register-disclosures'
import { applyNoteOverrides, normalizeNoteOverrides } from './note-overrides'
import {
  anyAssetHasComponents,
  buildK3RedovisningsPrinciper,
  buildMateriellaAnlaggningsNot,
  buildUppskjutenSkattNot,
} from './k3-noter-builder'
import {
  buildAnlaggningstillgangarNote,
  computeRollforwardTotals,
  depreciationPrincipleLines,
  depreciationPrinciples,
  holdsWriteDowns,
  type AnlaggningAsset,
} from './anlaggningstillgangar-note'
import {
  alignCarryingWithBalanceSheet,
  buildK2FixedAssetTables,
  fixedAssetNoteBody,
  fixedAssetNoteCarryingTotal,
  normalizeFixedAssetNoteRows,
  fixedAssetPostTieOut,
  carriedFromEarlierYears,
  statedTranslationIssues,
  statedWriteDownIssues,
  unstatedWriteDownReleases,
} from './k2-fixed-asset-note'
import {
  computeAssetNoteFigures,
  hasComponentRows,
  loadPostedSchedules,
  loadTransitionSplitOpenings,
  noteAsset,
} from './asset-note-figures'
import { k2EquityPosts, loadEquityEntries, loadEquitySpecification } from './equity-specification'
import { K3_SPLITS, k3EquityPosts, toK3Presentation } from './k3-presentation'
import { USER_CLASSIFIABLE_KINDS, type EquityMovementKind } from './equity-kinds'
import { collectDisclosureFacts, normalizeDisclosureAnswers, type DisclosureAnswers, type DisclosureFacts } from './disclosures'
import {
  buildFinancialFixedAssetsNote,
  buildTangibleImpairmentNote,
  grossMovementsByPost,
  hasBothWriteDownMovements,
  tangibleImpairmentBalance,
  withoutInternalMovements,
  writeDownsOutsideRegisterByPost,
} from './ledger-fixed-asset-notes'
import { hasMedelantalOverride, resolveMedelantalAnstallda } from '@/lib/salary/medelantal'
import type {
  ArsredovisningData,
  EgenKapitalRow,
  FlerarsoversiktRow,
  NoteEntry,
  KassaflodesAnalysisSummary,
  MemberDisclosures,
} from './types'
import type { Asset, TrialBalanceRow } from '@/types'

import { isEntityType, preparesArsredovisning } from '@/lib/company/entity-type'
import {
  getFiscalPeriodFramework,
  previousYearFrameworkOf,
  type AccountingFrameworkSource,
  type PreviousYearFramework,
} from '@/lib/company/accounting-framework'

/** Warning when the K3 kassaflödesanalys cannot be generated. Exported so
 *  buildCanonicalAnnualReport can drop it when the statement is omitted by
 *  choice (cash-flow-omission.ts): a failure to build a statement the
 *  document leaves out is not something the user has to fix. */
export const K3_CASH_FLOW_FAILED_WARNING =
  'Kassaflödesanalysen kunde inte genereras automatiskt. Kontrollera att ingående och utgående saldo på 19xx finns och kör om bokslutet.'
export const K3_CASH_FLOW_TAX_ALLOCATION_WARNING = getErrorMessage(new CashFlowTaxAllocationError())

/** The K3 notice enumerating what the PDF contains. */
export function k3ContentsNotice(hasCashFlow: boolean): string {
  return (
    'Bolaget redovisar enligt K3 (BFNAR 2012:1). Soliditeten är beräknad med 79,4 % av obeskattade reserver inräknat i eget kapital. PDF:en innehåller '
    + (hasCashFlow ? 'kassaflödesanalys, förändring av eget kapital och utökade noter' : 'förändring av eget kapital och utökade noter')
    + ': granska innehållet mot er specifika redovisning innan inlämning.'
  )
}

/**
 * The statements an annual report was built from, handed on so the iXBRL
 * input reuses them instead of building its own trial balances and mapping
 * (buildIxbrlInput). Not part of ArsredovisningData: the data is versioned
 * and hashed, the statements are only how it was computed.
 */
export interface AnnualReportStatements {
  /** The K2 mapping of the current year against the comparison year. */
  mapping: K2MappingResult
  /**
   * The comparison year (the year ending the day before this one starts,
   * pickPreviousFiscalPeriod), null when there is none. `loaded` is false when its trial balances could not be built:
   * the statements then carry no comparison column.
   */
  comparison: { id: string; period_start: string; period_end: string; loaded: boolean } | null
}

/** Registered share capital behind the Aktiekapital note (ÅRL 5 kap. 14 §). */
export interface ShareCapital {
  aktiekapital: number
  antalAktier: number
}

/**
 * What a K3 report hands the model for the steps that need the size class
 * and the compliance profile (model.ts): the facts of the books for the
 * disclosure matrix, the user's answers, and what Accounted knows about the
 * previous year's framework (the first-K3-year check).
 */
export interface K3BuildContext {
  facts: Omit<DisclosureFacts, 'publicCompany'>
  answers: DisclosureAnswers
  previousYear: PreviousYearFramework
}

export interface ArsredovisningBuild {
  data: ArsredovisningData
  statements: AnnualReportStatements
  /** K3 only: the inputs of the disclosure matrix and the K3 scope checks. */
  k3?: K3BuildContext | null
  /** The figures the Aktiekapital note prints, so the iXBRL document can tag
   *  its amount; null when there is no such note. */
  shareCapital?: ShareCapital | null
  /** Where the year's framework comes from (accounting-framework.ts): a
   *  company default or fallback is not a confirmed choice for the year. */
  frameworkSource?: AccountingFrameworkSource
}

/**
 * Pre-populate the K2 årsredovisning data for a fiscal period. Loads:
 *   - Income statement + balance sheet for the current period
 *   - Up to 3 prior periods for the flerårsöversikt
 *   - Asset register so noter can list avskrivningstider per category
 *   - Active employees count for medelantal anställda
 *   - Equity-account movements for förändring av eget kapital
 *
 * Manually-authored fields (description, important_events,
 * resultatdisposition, ställda säkerheter, eventualförpliktelser) are
 * pre-filled with sensible boilerplate the user can replace. The narrative
 * editor in the UI persists overrides via /api/.../arsredovisning POST.
 */
export async function buildArsredovisningData(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  overrides: Partial<ArsredovisningData['forvaltningsberattelse']> = {},
): Promise<ArsredovisningData> {
  return (await buildArsredovisningReport(supabase, companyId, fiscalPeriodId, overrides)).data
}

/**
 * buildArsredovisningData plus the statements it was computed from. Every
 * trial balance is built once per period and variant, all of them on one
 * read of the chart of accounts.
 */
export async function buildArsredovisningReport(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  overrides: Partial<ArsredovisningData['forvaltningsberattelse']> = {},
): Promise<ArsredovisningBuild> {
  // The RR/BR are rendered at ÅRL post level from the same K2 risbs mapping
  // that drives the iXBRL filing, never from per-account report rows.
  // Bolagsverket rejects balans-/resultaträkningar med kontonummer, so the
  // statement data must not carry account-level granularity at all. Two TB
  // variants per year (see TrialBalancePair): the FULL trial balance drives
  // the BR (2099 booked), the PRE-CLOSING one drives the RR (class 3-8
  // still open).
  // One chart read for every trial balance below; the read runs alongside
  // the first wave, as each balance's own read did.
  const chart = fetchTrialBalanceChart(supabase, companyId)
  const [periodResult, settingsResult, companyResult, periodList, tbFull, tbPreClosing, narrative, yearFramework] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, previous_period_id, closing_entry_id, is_closed')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, registered_office, entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
    // Source-of-truth for entity_type lives on companies.
    // company_settings.entity_type is a legacy mirror.
    supabase
      .from('companies')
      .select('entity_type')
      .eq('id', companyId)
      .maybeSingle(),
    fetchAllRows(({ from, to }) =>
      supabase
        .from('fiscal_periods')
        .select('id, name, period_start, period_end')
        .eq('company_id', companyId)
        .order('period_start', { ascending: false })
        .range(from, to),
    ),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include', chart }),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'exclude-final', chart }),
    // Load persisted narrative overrides: replaces the URL-query-param
    // carry from earlier phases. Caller-supplied overrides (passed in via
    // the second arg) still win, so the API can layer per-request edits on
    // top of the saved baseline if needed. A failed read fails the build:
    // the narrative holds what the user wrote and the stated rows of the
    // anläggningstillgångar note, and a report built without them would be
    // another document that still ties.
    getNarrative(supabase, companyId, fiscalPeriodId),
    // The framework of THIS räkenskapsår (BFNAR 2012:4), never the company's
    // current choice: a later switch must not rebuild an earlier year.
    getFiscalPeriodFramework(supabase, companyId, fiscalPeriodId),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const accountingFramework = yearFramework.framework
  const settings = settingsResult.data
  // Avtal och åtaganden (Bolaget rollout): the registers write the
  // säkerheter, eventualförpliktelser and parent texts; the narrative's
  // free text overrides them (register-disclosures.ts). Null outside the
  // rollout and when nothing is registered, which leaves the document as
  // it was.
  const registerTexts = await loadRegisterNoteTexts(supabase, companyId, period.period_end)
  const companyRow = companyResult.data as { entity_type?: string | null } | null
  const companyName = settings?.company_name ?? 'Bolaget'
  const orgNumber = settings?.org_number ?? ''
  // Default to 'unknown' (not 'aktiebolag') when entity_type isn't set:   // otherwise the K2 guard in buildK2Noter would claim K2 for every
  // unconfigured company, which is exactly the false-assertion the guard
  // was added to prevent. Prefer the companies row over company_settings
  // since the multi-tenant refactor made companies the source of truth.
  const entityType =
    companyRow?.entity_type
    ?? (settings as { entity_type?: string } | null)?.entity_type
    ?? 'unknown'
  // company_settings stores the address as flat columns (address_line1,
  // postal_code, city): there is no `address` json column. Selecting one
  // made the whole settings query fail, so every ÅR fell back to "Bolaget"
  // with an empty org number.
  //
  // Säte is its own column (registered_office), never the postal town
  // (`city`): the two differ whenever the post goes to another town than the
  // municipality of the seat. Without a säte the report carries none, and
  // completeness refuses to finalise it (AR-COMPANY-REGISTERED-OFFICE).
  const registeredOffice =
    (settings as { registered_office?: string | null } | null)?.registered_office?.trim() || null

  // Previous fiscal year → jämförelsesiffror (ÅRL 3:5 §). Resolved from the
  // already-fetched period list; a TB failure downgrades to "no comparison
  // year" with a warning instead of blocking the whole document (partial SIE
  // imports can leave prior years without IB continuity).
  const statementWarnings: string[] = []
  // The year ending the day before this one starts (pickPreviousFiscalPeriod):
  // the link when it is adjacent, the date otherwise, never across a gap.
  const prevPeriodRow = pickPreviousFiscalPeriod(period, (periodList ?? []) as PeriodRow[])

  // Flerårsöversikt window: the current period + up to 3 prior (oldest
  // first). Resolved here so the prior-period trial balances it needs can
  // share one parallel wave with the comparative-year pair instead of being
  // fetched sequentially (and, for the previous year, twice).
  const sortedPeriods = [...((periodList ?? []) as PeriodRow[])].sort((a, b) =>
    a.period_start.localeCompare(b.period_start),
  )
  const currentIdx = sortedPeriods.findIndex((p) => p.id === fiscalPeriodId)
  const overviewSlice =
    currentIdx === -1 ? [] : sortedPeriods.slice(Math.max(0, currentIdx - 3), currentIdx + 1)

  // Every prior period needed by the comparatives and/or the flerårsöversikt
  // gets its TB pair fetched exactly once. Comparative RR figures need the
  // same statutory view as the current year: keep booked depreciation,
  // appropriations, and tax, excluding only the result-closing entry (also
  // when the previous system booked it and it arrived by SIE import). A
  // failed pair downgrades to null so a broken prior year (e.g. a
  // partial SIE import without IB continuity) never blocks the document.
  const tbTargets = new Map<string, PeriodRow>()
  if (prevPeriodRow) tbTargets.set(prevPeriodRow.id, prevPeriodRow)
  for (const p of overviewSlice) {
    if (p.id !== fiscalPeriodId) tbTargets.set(p.id, p)
  }
  const tbPairs = new Map<string, TrialBalancePair | null>()
  await Promise.all(
    [...tbTargets.values()].map(async (p) => {
      try {
        const [full, preClosing] = await Promise.all([
          generateTrialBalance(supabase, companyId, p.id, { closingEntry: 'include', chart }),
          generateTrialBalance(supabase, companyId, p.id, { closingEntry: 'exclude-final', chart }),
        ])
        tbPairs.set(p.id, { full: full.rows, preClosing: preClosing.rows })
      } catch {
        tbPairs.set(p.id, null)
      }
    }),
  )

  // Previous fiscal year comparison (jämförelsesiffror): a TB failure
  // downgrades to "no comparison year" with a warning instead of blocking.
  const previousTb = prevPeriodRow ? tbPairs.get(prevPeriodRow.id) ?? null : null
  if (prevPeriodRow && !previousTb) {
    statementWarnings.push(
      'Jämförelsesiffror kunde inte hämtas för föregående räkenskapsår, balans- och resultaträkningen visas utan jämförelseår. Kontrollera det föregående årets bokföring.',
    )
  }
  // A previous year that exists but holds no bookkeeping in Accounted (the
  // year was done in another system and klarmarkerad here) yields an all-zero
  // comparison column, not a missing one. ÅRL 3 kap. 5 § requires the prior
  // year's amount for every post, so say so instead of printing 0 kr silently
  // (observed 2026-09-04: 25 000 kr aktiekapital shown as 0 kr).
  if (
    prevPeriodRow &&
    previousTb &&
    previousTb.full.length === 0 &&
    previousTb.preClosing.length === 0
  ) {
    statementWarnings.push(
      `Föregående räkenskapsår (${prevPeriodRow.name}) saknar bokföring i Accounted, så jämförelsesiffrorna visar 0 kr. ÅRL 3 kap. 5 § kräver föregående års belopp för varje post. Bokför eller SIE-importera året innan årsredovisningen lämnas in; ett klarmarkerat år öppnas igen under Inställningar > Bokföring > Räkenskapsår.`,
    )
  }
  const isForening = entityType === 'ekonomisk_forening'
  // One equity table for every year the document presents (ÅRL 3 kap.
  // 10 a-10 b §§): the flerårsöversikt maps its earlier years with it too.
  const legalForm = k2LegalFormOf(entityType)
  // A year with no closing entry yet still has its result on the result
  // accounts: it is previewed with Årets resultat from the income statement
  // as the books stand (mapping.currentYearDerived). Completeness
  // keeps such a report from being locked until the close is booked
  // (AR-YEAR-NOT-CLOSED). A closed year is read as booked, as before.
  const currentYearOpen = period.is_closed !== true && !period.closing_entry_id
  const mapping = mapTrialBalancesToK2(
    { full: tbFull.rows, preClosing: tbPreClosing.rows },
    previousTb,
    { legalForm, currentYearOpen },
  )
  const previousPeriod =
    prevPeriodRow && previousTb
      ? {
          id: prevPeriodRow.id,
          name: prevPeriodRow.name,
          period_start: prevPeriodRow.period_start,
          period_end: prevPeriodRow.period_end,
        }
      : null

  // Merge precedence: caller overrides → persisted narrative → boilerplate
  const persistedDescription = narrative?.description ?? undefined
  const persistedEvents = narrative?.important_events ?? undefined
  const persistedRd = narrative?.resultatdisposition ?? undefined
  const persistedAgmDate = narrative?.agm_date ?? null

  const flerarsoversikt = buildFlerarsoversikt(overviewSlice, fiscalPeriodId, mapping, tbPairs, legalForm)

  // K3's own balance sheet posts (K3 4.3, ÅRL bilaga 1), carved out of the
  // K2 posts: the K2 mapping stays the source of every total, the
  // resultatdisposition and the iXBRL; a K2 report never passes here.
  const k3Presentation =
    accountingFramework === 'k3'
      ? toK3Presentation(mapping, tbFull.rows, previousTb ? previousTb.full : null)
      : null
  const balanceSheetMapping = k3Presentation ?? mapping

  const egen_kapital_changes = buildEquityChanges(mapping)
  // ÅRL 6 kap. 2 § andra stycket, K3 6.3: the changes in equity from the
  // year's verifikat, tied to the balance sheet below. One builder for K2
  // and K3 (equity-specification.ts); the K2 iXBRL equity table reads it too.
  const equity_specification = await loadEquitySpecification(supabase, companyId, {
    posts: k3Presentation ? k3EquityPosts(legalForm) : k2EquityPosts(legalForm),
    current: { period, tbRows: tbFull.rows },
    previous: prevPeriodRow && previousTb
      ? { period: prevPeriodRow, tbRows: previousTb.full as TrialBalanceRow[] }
      : null,
    balanceSheet: balanceSheetMapping,
    currentYearDerived: Boolean(mapping.currentYearDerived),
    overrides: equityMovementOverridesFrom(narrative?.equity_movement_overrides),
    placement: k3Presentation && narrative?.equity_statement_separate ? 'separate_statement' : 'management_report',
    // A K2 report names the rows as the K2 taxonomy does, as its iXBRL
    // document must (build-input.ts); the report says so itself, so a
    // version locked before those labels keeps the ones it was signed with.
    rowLabels: accountingFramework === 'k2' ? 'k2' : undefined,
  })
  const memberDisclosures = isForening ? memberDisclosuresFrom(narrative) : null
  const proposedDividend = narrative?.proposed_dividend ?? 0
  const retainedEarnings = mapping.br['BalanseratResultat']?.current ?? 0
  const sharePremiumReserve = mapping.br['Overkursfond']?.current ?? 0
  const currentYearResult = mapping.br['AretsResultatEgetKapital']?.current ?? 0
  const distributableEquity = mapping.totals.frittEgetKapital.current

  // Duplicate-value consistency with the RR (mirrors build-input.ts). Since
  // #1116 buildFlerarsoversikt maps every year through mapTrialBalancesToK2
  // on the pre-closing trial balance (Nettoomsattning = 3000-3799), so this
  // is not a class-3 correction: it pins the current and previous year to
  // the very mapping the RR is built from, so the FB table ties to the RR
  // two pages later by construction rather than by a second computation.
  // Older years have no RR in the document and keep their own mapping.
  if (flerarsoversikt.length > 0) {
    const lastIdx = flerarsoversikt.length - 1
    flerarsoversikt[lastIdx] = {
      ...flerarsoversikt[lastIdx],
      net_revenue: mapping.rr['Nettoomsattning']?.current ?? 0,
      result_after_financial: mapping.totals.resultatEfterFinansiellaPoster.current,
    }
    if (lastIdx > 0 && previousPeriod && flerarsoversikt[lastIdx - 1].year === previousPeriod.name) {
      flerarsoversikt[lastIdx - 1] = {
        ...flerarsoversikt[lastIdx - 1],
        net_revenue: mapping.rr['Nettoomsattning']?.previous ?? 0,
        result_after_financial: mapping.totals.resultatEfterFinansiellaPoster.previous ?? 0,
      }
    }
  }

  // K3 vs K2 split: K3 has a richer note set + a kassaflöde + a separate
  // equity-changes statement. The 18a/b warning that flagged "K3 noter not
  // yet emitted" is removed below now that we actually emit them.
  //
  // Kassaflödesanalys + separate equity-changes statement, K3 only. K2
  // mindre företag is exempt from kassaflödesanalys (BFNAR 2016:10 punkt
  // 5.2) and keeps equity changes inside förvaltningsberättelsen. The K3
  // noter and the kassaflödesanalys are independent reads, so they share
  // one round trip; the kassaflöde failure warning still lands AFTER the
  // noter warnings so the warnings array order is unchanged.
  let noter: NoteEntry[]
  let noterWarnings: string[]
  // Faults that make the document wrong as filed: completeness blocks on them.
  let noterErrors: string[] = []
  let shareCapital: ShareCapital | null = null
  let k3Assets: Asset[] = []
  let k3FixedAssetNoteFromRegister = false
  let kassaflodesanalys: KassaflodesAnalysisSummary | undefined
  if (accountingFramework === 'k3') {
    const [noterResult, cashFlowSettled] = await Promise.all([
      buildK3Noter(
        supabase,
        companyId,
        entityType,
        period.period_start,
        period.period_end,
        narrative,
        tbFull.rows,
        fiscalPeriodId,
        (periodList ?? []) as PeriodRow[],
        registerTexts,
      ),
      generateKassaflodesanalys(supabase, companyId, fiscalPeriodId).then(
        (cashFlow) => ({ ok: true as const, cashFlow }),
        (error: unknown) => ({ ok: false as const, error }),
      ),
    ])
    // User-edited note texts (K3 only: the K2 notes feed the iXBRL filing,
    // which this override path does not cover).
    noter = applyNoteOverrides(noterResult.notes, normalizeNoteOverrides(narrative?.note_overrides))
    noterWarnings = noterResult.warnings
    noterErrors = noterResult.errors
    k3Assets = noterResult.assets
    k3FixedAssetNoteFromRegister = noterResult.fixedAssetNoteFromRegister
    if (cashFlowSettled.ok) {
      const { cashFlow } = cashFlowSettled
      // Strip fiscal_period_id from the embedded report: period info is
      // already on ArsredovisningData.fiscal_period; carrying it twice in
      // the payload would be redundant.
      kassaflodesanalys = {
        period_start: cashFlow.period_start,
        period_end: cashFlow.period_end,
        lopande: cashFlow.lopande,
        investerings: cashFlow.investerings,
        finansierings: cashFlow.finansierings,
        total_cash_flow: cashFlow.total_cash_flow,
        unclassified_accounts: cashFlow.unclassified_accounts,
        reconciliation: cashFlow.reconciliation,
      }
    } else {
      // A partial SIE import can leave 1xxx without an IB row: the report
      // throws. Surface as a warning instead of blocking the whole ÅR.
      noterWarnings.push(cashFlowSettled.error instanceof CashFlowTaxAllocationError
        ? K3_CASH_FLOW_TAX_ALLOCATION_WARNING
        : K3_CASH_FLOW_FAILED_WARNING)
    }
  } else {
    const k2Noter = await buildK2Noter(
      supabase,
      companyId,
      entityType,
      period.period_start,
      period.period_end,
      narrative,
      tbFull.rows,
      fiscalPeriodId,
      (periodList ?? []) as PeriodRow[],
      yearFramework.change_reason,
      registerTexts,
      mapping.br,
    )
    noter = k2Noter.notes
    noterWarnings = k2Noter.warnings
    noterErrors = k2Noter.errors
    shareCapital = k2Noter.shareCapital
  }

  const resultatrakning = buildRrRows(mapping)
  const brRows = buildBrRows(balanceSheetMapping)

  // K3: the inputs of the disclosure matrix and of the K3 scope checks,
  // evaluated by the model once the size class and the profile are known.
  let k3: K3BuildContext | null = null
  if (accountingFramework === 'k3') {
    const shareCapitalRow = brRows.equityLiabilities.find((row) => row.semantic_key === 'balance_sheet_share_capital')?.current ?? null
    const equityRow = brRows.equityLiabilities.find((row) => row.semantic_key === 'balance_sheet_equity_total')?.current ?? null
    const { publicCompany: _publicCompany, ...facts } = collectDisclosureFacts({
      tbFullRows: tbFull.rows,
      assets: k3Assets,
      equitySpecification: equity_specification,
      fixedAssetNoteFromRegister: k3FixedAssetNoteFromRegister,
      equityBelowHalfShareCapital:
        shareCapitalRow !== null && equityRow !== null && shareCapitalRow > 0 && equityRow * 2 < shareCapitalRow,
      publicCompany: null,
    })
    k3 = {
      facts,
      answers: k3DisclosureAnswers(narrative),
      previousYear: await previousYearFrameworkOf(supabase, companyId, prevPeriodRow?.id ?? null),
    }
  }
  const balansrakning = {
    assets: brRows.assets,
    total_assets: mapping.totals.tillgangar.current,
    total_assets_previous: mapping.totals.tillgangar.previous,
    equity_liabilities: brRows.equityLiabilities,
    total_equity_liabilities: mapping.totals.egetKapitalSkulder.current,
    total_equity_liabilities_previous: mapping.totals.egetKapitalSkulder.previous,
  }

  // mapping.warnings carry the compliance-critical signals (unmapped
  // accounts whose balances are MISSING from the document, RR ≠ 2099,
  // obalans, reclass review nudges), surfacing them pre-download is what
  // keeps a non-fileable PDF from reaching Bolagsverket.
  const warnings: string[] = [
    ...statementWarnings,
    ...balanceSheetMapping.warnings,
    ...noterWarnings,
    ...equity_specification.warnings,
    ...registerOverrideWarnings(narrative, registerTexts),
  ]
  if (entityType !== 'aktiebolag' && entityType !== 'ekonomisk_forening' && entityType !== 'unknown') {
    warnings.push(
      'Den här årsredovisningen genereras med K2-mallen (BFNAR 2016:10) som standard. För K3- eller annan företagsform kan strukturen behöva justeras manuellt innan inlämning.',
    )
  }
  if (isForening && accountingFramework === 'k3') {
    warnings.push(
      'K3-dokumentet för ekonomisk förening använder aktiebolagets uppställning för förändringar i eget kapital: granska insatsposterna manuellt innan inlämning.',
    )
  }
  if (entityType === 'aktiebolag' && accountingFramework === 'k3') {
    // Soliditet now reflects the K3 split (79,4 % equity portion of 21xx is
    // folded into eget kapital). 18e/f provides the K3 noter, kassaflöde
    // and separate equity-changes statement so the PDF is now substantively
    // K3-compliant; we keep a soft notice here so the filer remembers to
    // verify the document against their specific obligations before sending
    // to Bolagsverket.
    // The enumeration is conditional on what was actually produced: when
    // generateKassaflodesanalys failed we already pushed "kunde inte
    // genereras" above, and claiming the PDF contains one in the very next
    // warning would contradict it on the same screen.
    warnings.push(k3ContentsNotice(Boolean(kassaflodesanalys)))
  }
  if (entityType === 'unknown') {
    warnings.push(
      'Företagsform saknas i inställningarna: fyll i Inställningar → Företag för att få rätt redovisningsprinciper i not 1.',
    )
  }
  // The adopting meeting is the årsstämma of an aktiebolag (ABL 7 kap. 10 §)
  // or the ordinarie föreningsstämma of an ekonomisk förening (EFL 6 kap.
  // 9 §); both fall within six months of the fiscal year end.
  const meetingLabel = isForening ? 'föreningsstämma' : 'årsstämma'
  const meetingRule = isForening ? 'EFL 6 kap. 9 §' : 'ABL 7 kap. 10 §'
  if (!persistedAgmDate) {
    warnings.push(
      `Datum för ${meetingLabel} saknas. Fastställelseintyget i PDF:en lämnas tomt på datumraden tills det fylls i nedan.`,
    )
  } else {
    // ÅRL 8 kap 3 §: the meeting must be held after the räkenskapsår ends
    // and within 6 months of period end. A date before period_end is
    // logically impossible; after the deadline is a legally defective
    // fastställelseintyg.
    if (persistedAgmDate <= period.period_end) {
      warnings.push(
        `Datum för ${meetingLabel} (${persistedAgmDate}) ligger på eller före räkenskapsårets slut (${period.period_end}): fastställelseintyget blir juridiskt felaktigt. Kontrollera datumet.`,
      )
    } else {
      const periodEndDate = new Date(`${period.period_end}T00:00:00Z`)
      const deadline = new Date(periodEndDate)
      deadline.setUTCMonth(deadline.getUTCMonth() + 6)
      const deadlineIso = deadline.toISOString().slice(0, 10)
      if (persistedAgmDate > deadlineIso) {
        warnings.push(
          `Datum för ${meetingLabel} (${persistedAgmDate}) är efter 6-månadersgränsen (${deadlineIso}). ${isForening ? 'Ordinarie föreningsstämma' : 'Årsstämman'} ska hållas inom 6 månader från räkenskapsårets slut (${meetingRule}).`,
        )
      }
    }
  }

  const data: ArsredovisningData = {
    company: {
      name: companyName,
      org_number: orgNumber,
      entity_type: entityType,
      registered_office: registeredOffice,
    },
    fiscal_period: {
      id: period.id,
      name: period.name,
      period_start: period.period_start,
      period_end: period.period_end,
    },
    previous_period: previousPeriod,
    accounting_framework: accountingFramework,
    // Only while the year's result is not closed: an absent key keeps the
    // content hash of every closed year's report unchanged.
    ...(mapping.currentYearDerived
      ? {
          result_pending_close: {
            result: mapping.currentYearDerived.result,
            carried_in: mapping.currentYearDerived.carriedIn,
          },
        }
      : {}),
    forvaltningsberattelse: {
      description:
        overrides.description ??
        persistedDescription ??
        (isForening
          ? `${companyName} bedriver verksamhet enligt ändamålet i föreningens stadgar.`
          : `${companyName} bedriver verksamhet enligt verksamhetsbeskrivningen i bolagsordningen.`),
      important_events:
        overrides.important_events ??
        persistedEvents ??
        'Inga väsentliga händelser utöver löpande verksamhet har inträffat under räkenskapsåret.',
      kontrollbalans_required: overrides.kontrollbalans_required ?? false,
      flerarsoversikt,
      // The year's choice to state the flerårsöversikt in tkr. Only present
      // when on: an absent key keeps the content hash of every other report.
      ...(narrative?.flerarsoversikt_tkr === true ? { flerarsoversikt_tkr: true } : {}),
      egen_kapital_changes,
      resultatdisposition:
        overrides.resultatdisposition ??
        persistedRd ??
        'Styrelsen föreslår att årets resultat balanseras i ny räkning.',
      proposed_dividend: proposedDividend,
      resultatdisposition_amounts: {
        retained_earnings: retainedEarnings,
        share_premium_reserve: sharePremiumReserve,
        current_year_result: currentYearResult,
        total: distributableEquity,
        proposed_dividend: proposedDividend,
        carried_forward: distributableEquity - proposedDividend,
      },
      agm_date: persistedAgmDate,
      // Only present for an ekonomisk förening: an absent key keeps the
      // content hash of every existing aktiebolag report unchanged.
      ...(memberDisclosures ? { member_disclosures: memberDisclosures } : {}),
      agm_disposition_outcome: narrative?.agm_disposition_outcome ?? null,
      agm_disposition_decision: narrative?.agm_disposition_decision ?? null,
    },
    resultatrakning,
    warnings,
    // Present only when there is one: an absent key keeps the content hash of
    // every report without a fault unchanged.
    ...(noterErrors.length > 0 ? { errors: noterErrors } : {}),
    balansrakning,
    noter,
    kassaflodesanalys,
    equity_specification,
    signatures: [], // populated by signature-flow service in a later phase step
    disclosures: {
      long_term_debt_over_five_years: narrative?.long_term_debt_over_five_years ?? null,
      securities_pledged: narrative?.securities_pledged ?? null,
      contingent_liabilities: narrative?.contingent_liabilities ?? null,
      parent_company_name: narrative?.parent_company_name ?? null,
      parent_company_org_number: narrative?.parent_company_org_number ?? null,
      parent_company_city: narrative?.parent_company_city ?? null,
      // Present only when a register has something to say: an absent key
      // keeps the content hash of every other report unchanged.
      ...(registerTexts ? { from_registers: registerTexts } : {}),
      medelantal_anstallda_override: narrative?.medelantal_anstallda_override ?? null,
      ...(memberDisclosures
        ? {
            member_count_change: memberDisclosures.member_count_change,
            insatser_repayable_next_year: memberDisclosures.insatser_repayable_next_year,
            forlagsinsatser_dividend_right: memberDisclosures.forlagsinsatser_dividend_right,
            forlagsinsatser_redeemable_two_years: memberDisclosures.forlagsinsatser_redeemable_two_years,
          }
        : {}),
      omit_kassaflodesanalys: narrative?.omit_kassaflodesanalys ?? false,
      kassaflodesanalys_omission_confirmed:
        narrative?.kassaflodesanalys_omission_confirmed ?? false,
      // K3 only, so a K2 report's data and content hash are unchanged.
      ...(accountingFramework === 'k3'
        ? {
            disclosure_answers: k3DisclosureAnswers(narrative),
            equity_movement_overrides: equityMovementOverridesFrom(narrative?.equity_movement_overrides),
            equity_statement_separate: narrative?.equity_statement_separate ?? false,
          }
        : {}),
      confirmations: {
        long_term_debt_over_five_years:
          narrative?.long_term_debt_over_five_years_confirmed ?? false,
        securities_pledged: narrative?.securities_pledged_confirmed ?? false,
        contingent_liabilities: narrative?.contingent_liabilities_confirmed ?? false,
        parent_company: narrative?.parent_company_confirmed ?? false,
      },
    },
  }
  return {
    data,
    statements: {
      mapping,
      comparison: prevPeriodRow
        ? {
            id: prevPeriodRow.id,
            period_start: prevPeriodRow.period_start,
            period_end: prevPeriodRow.period_end,
            loaded: previousTb !== null,
          }
        : null,
    },
    shareCapital,
    k3,
    frameworkSource: yearFramework.source,
  }
}

/**
 * The stored answers to the K3 disclosure matrix. A text the user wrote for
 * the note on väsentliga händelser efter balansdagen before the matrix
 * existed (note_overrides) stands as the answer until the matrix question is
 * answered, so no user text is dropped.
 */
function k3DisclosureAnswers(
  narrative: { disclosure_answers?: unknown; note_overrides?: unknown } | null | undefined,
): DisclosureAnswers {
  const answers = normalizeDisclosureAnswers(narrative?.disclosure_answers)
  const legacyEventsAfter = normalizeNoteOverrides(narrative?.note_overrides).vasentliga_handelser_efter_balansdagen
  if (answers[EVENTS_AFTER_REQUIREMENT] || !legacyEventsAfter) return answers
  return { ...answers, [EVENTS_AFTER_REQUIREMENT]: { applies: true, text: legacyEventsAfter } }
}

const EVENTS_AFTER_REQUIREMENT = 'not.handelser_efter_balansdagen'

/** The stored classifications, keeping only kinds a user may assign. */
function equityMovementOverridesFrom(value: unknown): Record<string, EquityMovementKind> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const allowed = new Set<string>(USER_CLASSIFIABLE_KINDS)
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(
      (entry): entry is [string, EquityMovementKind] => typeof entry[1] === 'string' && allowed.has(entry[1]),
    ),
  )
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

/**
 * Medelantal anställda note body, plus a warning when the figure is missing
 * rather than zero. The FTE average is computed from Löner employee records
 * only; a company whose salary is booked without them (hand-booked, SIE
 * import, a migrated year) computes 0 and used to read "Bolaget har inte
 * haft några anställda" while 7xxx carried a full year of löner (feedback
 * seq 366434). Posted activity on 7000-7399 in the period with no manual
 * figure is the signal that the roster, not the payroll, is empty: the note
 * then says the figure is missing and the preview flags it. An explicit
 * override (0 included) is the user's statement and wins. Pure; shared by
 * the K2 and K3 noter builders so the two frameworks cannot disagree.
 */
export function resolveMedelantalNote(args: {
  medelantal: number
  hasOverride: boolean
  tbFullRows: Array<Pick<TrialBalanceRow, 'account_number' | 'period_debit' | 'period_credit'>>
  /** "Bolaget" for an aktiebolag, "Föreningen" for an ekonomisk förening. */
  subject?: string
}): { body: string; warning: string | null } {
  if (args.medelantal > 0) {
    return {
      body: `Under räkenskapsåret har medeltalet anställda uppgått till ${args.medelantal}.`,
      warning: null,
    }
  }
  // Period activity, not the closing net: with the closing entry included
  // every 7xxx account nets to zero after bokslut.
  const salaryPosted = args.tbFullRows.some(
    (r) =>
      r.account_number >= '7000' &&
      r.account_number <= '7399' &&
      ((r.period_debit || 0) !== 0 || (r.period_credit || 0) !== 0),
  )
  if (!args.hasOverride && salaryPosted) {
    return {
      body: 'Uppgift om medelantal anställda saknas: ange antalet under Årsredovisning (not Medelantal anställda).',
      warning:
        'Löner är bokförda på konto 7000-7399 men medelantal anställda kunde inte beräknas (inga anställda registrerade under Löner): ange antalet under Årsredovisning (not Medelantal anställda).',
    }
  }
  return {
    body: `${args.subject ?? 'Bolaget'} har inte haft några anställda under räkenskapsåret.`,
    warning: null,
  }
}

export function calculateSoliditet(mapping: K2MappingResult): number | null {
  const totalAssets = mapping.totals.tillgangar.current
  if (totalAssets <= 0) return null
  const adjustedEquity =
    mapping.totals.egetKapital.current +
    mapping.totals.obeskattadeReserver.current * (1 - LATENT_TAX_DEFAULT_RATE)
  return Math.round((adjustedEquity / totalAssets) * 1000) / 10
}

/**
 * Flerårsöversikt from pre-fetched trial-balance pairs. `overviewSlice` is
 * the current period + up to 3 prior, oldest first (resolved by the caller
 * so the pairs could be fetched in one parallel wave); `tbPairs` holds the
 * prior-period pairs, with null marking a period whose TB fetch failed.
 */
function buildFlerarsoversikt(
  overviewSlice: PeriodRow[],
  currentPeriodId: string,
  currentMapping: K2MappingResult,
  tbPairs: Map<string, TrialBalancePair | null>,
  legalForm: K2LegalForm,
): FlerarsoversiktRow[] {
  const rows: FlerarsoversiktRow[] = []
  for (const p of overviewSlice) {
    try {
      let mapping = currentMapping
      if (p.id !== currentPeriodId) {
        const pair = tbPairs.get(p.id)
        if (!pair) throw new Error('trial balance unavailable')
        // A prior year that was never closed in these books has its result
        // derived, as in the balance sheet's comparison column: soliditet
        // would otherwise be computed on equity without that year's result.
        // Same equity table as the current year: an ekonomisk förening's
        // soliditet is read from medlemsinsatser and förlagsinsatser every
        // year, never from the aktiebolag table.
        mapping = mapTrialBalancesToK2(pair, null, { currentIsPriorYear: true, legalForm })
      }
      const netRevenue = mapping.rr['Nettoomsattning']?.current ?? 0
      const resultAfterFinancial = mapping.totals.resultatEfterFinansiellaPoster.current
      // K2 flerårsöversikt defines soliditet as adjusted equity divided by
      // total assets. Adjusted equity includes the equity portion of untaxed
      // reserves even though those reserves remain a separate BR section.
      const soliditet = calculateSoliditet(mapping)
      rows.push({
        year: p.name,
        net_revenue: Math.round(netRevenue),
        result_after_financial: Math.round(resultAfterFinancial),
        soliditet_pct: soliditet,
      })
    } catch {
      // Prior periods may lack continuity if SIE import was partial. Skip
      // rather than blocking the whole årsredovisning.
      rows.push({
        year: p.name,
        net_revenue: 0,
        result_after_financial: 0,
        soliditet_pct: null,
      })
    }
  }
  return rows
}

/** ÅRL 6 kap. 3 § inputs for an ekonomisk förening, read from the narrative row. */
function memberDisclosuresFrom(
  narrative: {
    member_count_change?: string | null
    insatser_repayable_next_year?: number | null
    forlagsinsatser_dividend_right?: string | null
    forlagsinsatser_redeemable_two_years?: number | null
  } | null,
): MemberDisclosures {
  return {
    member_count_change: narrative?.member_count_change ?? null,
    insatser_repayable_next_year: narrative?.insatser_repayable_next_year ?? null,
    forlagsinsatser_dividend_right: narrative?.forlagsinsatser_dividend_right ?? null,
    forlagsinsatser_redeemable_two_years: narrative?.forlagsinsatser_redeemable_two_years ?? null,
  }
}

/**
 * Förvaltningsberättelsens "Förändring av eget kapital" table, post-level
 * labels only (no kontonummer). Only genuine equity posts (20xx) appear;
 * obeskattade reserver are NOT eget kapital and were dropped from the table
 * when the account-row version was replaced by the mapping-driven one.
 */
function buildEquityChanges(mapping: K2MappingResult): EgenKapitalRow[] {
  const posts: Array<{ label: string; concept: string; alwaysShow?: boolean }> =
    mapping.legalForm === 'ekonomisk_forening'
      ? [
          // ÅRL 3 kap. 10 b §: insatser as their own posts, no share capital.
          { label: 'Medlemsinsatser', concept: 'Medlemsinsatser', alwaysShow: true },
          { label: 'Förlagsinsatser', concept: 'Forlagsinsatser' },
          { label: 'Uppskrivningsfond', concept: 'Uppskrivningsfond' },
          { label: 'Reservfond', concept: 'Reservfond' },
          { label: 'Balanserat resultat', concept: 'BalanseratResultat', alwaysShow: true },
          { label: 'Årets resultat', concept: 'AretsResultatEgetKapital', alwaysShow: true },
        ]
      : [
          { label: 'Aktiekapital', concept: 'Aktiekapital', alwaysShow: true },
          { label: 'Ej registrerat aktiekapital', concept: 'EjRegistreratAktiekapital' },
          { label: 'Bunden överkursfond', concept: 'OverkursfondBunden' },
          { label: 'Uppskrivningsfond', concept: 'Uppskrivningsfond' },
          { label: 'Reservfond', concept: 'Reservfond' },
          { label: 'Överkursfond', concept: 'Overkursfond' },
          { label: 'Balanserat resultat', concept: 'BalanseratResultat', alwaysShow: true },
          { label: 'Årets resultat', concept: 'AretsResultatEgetKapital', alwaysShow: true },
        ]
  const rows: EgenKapitalRow[] = []
  for (const post of posts) {
    const amount = mapping.br[post.concept]?.current ?? 0
    if (amount === 0 && !post.alwaysShow) continue
    rows.push({ label: post.label, amount })
  }
  rows.push({ label: 'Summa eget kapital', amount: mapping.totals.egetKapital.current })
  return rows
}

/**
 * Map register assets to the roll-forward note input, resolving per-asset
 * depreciation figures from posted schedules (engine fallback) so the note
 * ties to the ledger. Shared by the K2 and K3 note builders. Skips the
 * schedules query entirely when the register is empty.
 */
async function buildRollforwardAssets(
  supabase: SupabaseClient,
  companyId: string,
  assets: Asset[],
  allPeriods: PeriodRow[],
  fiscalPeriodId: string,
): Promise<AnlaggningAsset[]> {
  if (assets.length === 0) return []
  // Only an asset with components can have been split at the transition to K3.
  const [schedules, transitionSplits] = await Promise.all([
    loadPostedSchedules(supabase, companyId),
    assets.some(hasComponentRows) ? loadTransitionSplitOpenings(supabase, companyId) : Promise.resolve([]),
  ])
  const figures = computeAssetNoteFigures({
    assets,
    postedSchedules: schedules,
    fiscalPeriods: allPeriods,
    currentPeriodId: fiscalPeriodId,
    transitionSplits,
  })
  const period = allPeriods.find((row) => row.id === fiscalPeriodId)
  const splitByAsset = new Map(transitionSplits.map((split) => [split.asset_id, split]))
  // A year before a K3 transition split reads the plain asset it was then.
  const asOfPeriod = (asset: Asset) =>
    period ? noteAsset(asset, splitByAsset.get(asset.id), period.period_start) : asset
  return assets.map(asOfPeriod).map((a) => ({
    category: a.category,
    acquisition_date: a.acquisition_date,
    acquisition_cost: a.acquisition_cost,
    salvage_value: a.salvage_value,
    useful_life_months: a.useful_life_months,
    disposed_at: a.disposed_at,
    acquisition_type: a.acquisition_type,
    bas_asset_account: a.bas_asset_account,
    figures: figures.get(a.id) ?? { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 },
    // ÅRL 5 kap. 8 § p. 5: the year's nedskrivningar, from posted vouchers.
    ...(period ? { writeDowns: writeDownMovement(a, period.period_start, period.period_end) } : {}),
  }))
}

/**
 * Cross-check the roll-forward note's closing book value against the
 * balansräkning (full TB net of accounts 1000-1299: immateriella +
 * materiella anläggningstillgångar; 13xx financial assets are outside the
 * note). Returns the user-facing message when they diverge by more than
 * 1 kr, which is the exact inconsistency ÅRL 5:8 § forbids in a filed
 * document. Blocking when the register holds write-downs: the note then
 * reports nedskrivningar that do not tie to the books, so the document may
 * not be locked as it stands; otherwise a warning (a register approximated
 * before onboarding can differ by design).
 */
function rollforwardTieOut(
  /** The note's closing redovisat värde over every post. */
  ubRedovisat: number,
  tbFullRows: TrialBalanceRow[],
  /** The register holds write-downs (holdsWriteDowns): a mismatch blocks. */
  registerHoldsWriteDowns: boolean,
  /**
   * Accumulated nedskrivningar booked outside the register, net debit: the
   * ledger note discloses them, so the comparison counts them once
   * (tangibleImpairmentBalance). The register's own are in the roll-forward.
   */
  impairments = 0,
): { message: string; blocking: boolean } | null {
  const tbNet = tbFullRows
    .filter((r) => r.account_number >= '1000' && r.account_number < '1300')
    .reduce((sum, r) => sum + (r.closing_debit || 0) - (r.closing_credit || 0), 0)
  if (Math.abs(ubRedovisat + impairments - tbNet) <= 1) return null
  const fmtKr = (n: number) => Math.round(n).toLocaleString('sv-SE')
  const message = `Anläggningsnotens utgående redovisade värde (${fmtKr(ubRedovisat + impairments)} kr) stämmer inte med balansräkningens bokförda värde för konto 1000-1299 (${fmtKr(tbNet)} kr). Kontrollera att anläggningsregistret är komplett och att årets avskrivningar är bokförda.`
  if (!registerHoldsWriteDowns) return { message, blocking: false }
  return {
    message: `${message} Anläggningsregistret har nedskrivningar (ÅRL 4 kap. 5 §): noten måste stämma mot balansräkningen innan årsredovisningen kan låsas. Kontrollera att nedskrivningarna och deras återföringar är bokförda på tillgångarnas konton.`,
    blocking: true,
  }
}

async function buildK2Noter(
  supabase: SupabaseClient,
  companyId: string,
  entityType: string,
  periodStart: string,
  periodEnd: string,
  narrative: NarrativeRow | null,
  tbFullRows: TrialBalanceRow[],
  fiscalPeriodId: string,
  allPeriods: PeriodRow[],
  /** BFNAR 2012:4 punkt 3: the stated reasons when the year switched from K3 to K2. */
  frameworkSwitchReason: string | null = null,
  registerTexts: RegisterDisclosureTexts | null = null,
  /** The balance sheet posts as the document prints them (the mapping's br): the notes repeat them. */
  balanceSheet: K2MappingResult['br'] | null = null,
): Promise<{ notes: NoteEntry[]; warnings: string[]; errors: string[]; shareCapital: ShareCapital | null }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []
  const errors: string[] = []
  let shareCapital: ShareCapital | null = null
  // Note 1: framework. Only claim K2 explicitly when we know the company is
  // an AB and using K2: otherwise emit a generic principles note so the
  // ÅR doesn't falsely assert a framework the company isn't on.
  // Every form that prepares an årsredovisning here (aktiebolag, ekonomisk
  // förening) is on K2 in this builder; an unknown or other form gets the
  // generic wording so the note never asserts a framework it is not on.
  const preparesAnnualReport = isEntityType(entityType) && preparesArsredovisning(entityType)
  const isAbK2 = entityType === 'aktiebolag'
  const principles = preparesAnnualReport
    ? 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).'
    : 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd.'
  notes.push({
    number: 1,
    title: 'Redovisnings- och värderingsprinciper',
    // A switch of K-regelverk is a change of accounting principle, and a
    // company that left K3 for K2 states its reasons in a note (BFNAR 2012:4
    // punkt 3). It sits in the principles note, the note the iXBRL document
    // tags as RedovisningsVarderingsprinciper; without a switch the body is
    // unchanged.
    body: frameworkSwitchReason?.trim()
      ? `${principles}\n\nByte av regelverk: Från och med detta räkenskapsår tillämpar företaget BFNAR 2016:10 (K2) i stället för BFNAR 2012:1 (K3). Skälen för bytet: ${frameworkSwitchReason.trim()}`
      : principles,
  })

  // Note: aktiekapital. K2 punkt 18.x requires AB to disclose share-capital
  // structure. Read from company_settings when present; surface a warning
  // when missing so the user knows to fill it in. We also surface the
  // warning when entityType is 'unknown' since the company may in fact be
  // an AB the user just hasn't configured yet: staying silent would let
  // them download an incomplete K2 ÅR without realising.
  const maybeAb = isAbK2 || entityType === 'unknown'

  // The three reads feeding the notes below (aktiekapital settings, asset
  // register, employee windows) are independent, so they share one parallel
  // round trip instead of three sequential ones. Note bodies, push order,
  // and numbering (notes.length + 1) are unchanged.
  const [settingsResult, assets, employeesResult] = await Promise.all([
    maybeAb
      ? supabase
          .from('company_settings')
          .select('aktiekapital, antal_aktier')
          .eq('company_id', companyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    listAssets(supabase, companyId),
    supabase
      .from('employees')
      .select('employment_start, employment_end, employment_degree')
      .eq('company_id', companyId),
  ])

  if (maybeAb) {
    type AktiekapitalShape = { aktiekapital?: number | null; antal_aktier?: number | null }
    const ak = (settingsResult.data ?? null) as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    // Kvotvärde is defined (ABL 1 kap 6 §) as aktiekapital / antal aktier;
    // deriving it here keeps the filed note internally consistent. The note
    // is voluntary for a mindre företag; ÅRL 5 kap. 34 § requires the number
    // of shares and the kvotvärde of a större företag, so a partial pair is
    // treated as missing (warn, no note).
    if (aktiekapital && antalAktier) {
      const kvotvarde = roundOre(aktiekapital / antalAktier)
      shareCapital = { aktiekapital, antalAktier }
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: [
          `Aktiekapital: ${aktiekapital.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr.`,
          `Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`,
          `Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`,
        ].join(' '),
      })
    } else {
      // Don't write a "saknas: komplettera" placeholder into the PDF body:       // that text would land in the Bolagsverket-filed document as a user-
      // facing error string and the filing would be K2-non-compliant
      // (BFNAR 2016:10 punkt 5.4 / ÅRL 5 kap 14 § require the actual
      // registered amount). Omit the note entirely and surface a warning so
      // the UI can flag this pre-download.
      warnings.push(
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K2 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
      )
    }
  }

  // Avskrivningstider: derive from asset register (supplementary
  // disclosure; the statutory ÅRL 5:8 § roll-forward follows below). Per
  // balance sheet post, so the iXBRL document can tag each row as its post's
  // table of avskrivningsprinciper.
  // The register as it stood on the balance sheet date: an asset bought after
  // it is not in this year's report, and one sold after it still was.
  const heldAtYearEnd = assets
    .filter((asset) => asset.acquisition_date <= periodEnd)
    .map((asset) => (asset.disposed_at && asset.disposed_at > periodEnd ? { ...asset, disposed_at: null } : asset))
  const depreciationPeriods = depreciationPrinciples(heldAtYearEnd, {
    postOfAccount: (account) => k2BrPostForAccount(account, k2LegalFormOf(entityType)),
    labelOfPost: (post) => k2AssetPostLabel(post) ?? post,
  })
  const depreciationLines = depreciationPrincipleLines(depreciationPeriods)
  if (depreciationLines.length > 0) {
    notes.push({
      number: notes.length + 1,
      title: 'Avskrivningar',
      body: depreciationLines.join('\n'),
      ...(depreciationPeriods.rows.length > 0 ? { depreciationPrinciples: depreciationPeriods.rows } : {}),
    })
  }

  // Anläggningstillgångar roll-forward (ÅRL 5:8 §). Per-category IB →
  // tillkommande → avgående → UB anskaffningsvärde, same for ackumulerade
  // avskrivningar, ending in utgående redovisat värde. Hard ÅR requirement
  // for any company with assets on the books. Depreciation figures come
  // from posted schedules so the note ties to the balansräkning.
  const rollforwardAssets = await buildRollforwardAssets(
    supabase,
    companyId,
    assets,
    allPeriods,
    fiscalPeriodId,
  )
  // One table per balance sheet post (the K2 taxonomy tags the note per
  // post), every figure from one source (k2-fixed-asset-note.ts): the
  // register, what the post's write-down accounts hold beyond the register,
  // and the few rows neither can tell apart as the user stated them.
  const statedRows = normalizeFixedAssetNoteRows(narrative?.fixed_asset_note_rows)
  // An omräkningsdifferens stated in an earlier year is still on the post's
  // accounts: the year opens with what the years before it stated. One read,
  // and none for a company's first year.
  const earlierPeriods = allPeriods
    .filter((earlier) => earlier.period_end < periodStart)
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
  const statedByPeriod = earlierPeriods.length > 0 ? await listFixedAssetNoteRows(supabase, companyId) : null
  const carried = carriedFromEarlierYears(earlierPeriods.flatMap((earlier) => statedByPeriod?.get(earlier.id) ?? []))
  const legalForm = k2LegalFormOf(entityType)
  const postOfAccount = (account: string) => k2BrPostForAccount(account, legalForm)
  const registeredWriteDowns = registerWriteDownsByAccount(assets, periodStart, periodEnd)
  let outsideWriteDowns = writeDownsOutsideRegisterByPost(tbFullRows, registeredWriteDowns, postOfAccount)
  // Write-down accounts that were both credited and debited beyond the
  // register may hold a movement between two accounts of the post, or a
  // verifikat with its storno: neither is a nedskrivning or an återföring.
  // The year's verifikat on those accounts say which (one read, and only then).
  const bothWays = [...outsideWriteDowns.values()].filter(hasBothWriteDownMovements)
  if (bothWays.length > 0) {
    const vouchers = await loadEquityEntries(
      supabase,
      companyId,
      { id: fiscalPeriodId, name: '', period_start: periodStart, period_end: periodEnd, opening_balance_entry_id: null },
      bothWays.flatMap((sum) => sum.accounts),
    )
    outsideWriteDowns = withoutInternalMovements(outsideWriteDowns, vouchers)
  }
  const labelOfPost = (post: string) => k2AssetPostLabel(post) ?? post
  const fixedAssetTables = buildK2FixedAssetTables({
    assets: rollforwardAssets,
    periodStart,
    periodEnd,
    stated: statedRows,
    postOfAccount,
    labelOfPost,
    postOrder: K2_BR_MAPPINGS.map((mapping) => mapping.concept),
    outsideWriteDowns,
    carried,
  })
  // A stated nedskrivning row must be booked on the post's write-down accounts.
  errors.push(...statedWriteDownIssues(statedRows, outsideWriteDowns, labelOfPost))
  // One source per nedskrivning: a post with a table shows all of its own
  // there; the write-down accounts of the other posts go in the ledger
  // note, as under K3 (a write-down booked by hand is disclosed, never twice).
  const inTables = new Set(
    fixedAssetTables.flatMap((table) => (table.post ? (outsideWriteDowns.get(table.post)?.accounts ?? []) : [])),
  )
  const ledgerNoteRows = tbFullRows.filter((row) => !inTables.has(row.account_number))
  if (fixedAssetTables.length > 0) {
    // Each post against the books of its own balance sheet post, at the end
    // of the year and at its start, then the note as a whole as before. One
    // message per cause: the whole is not reported on top of a post with
    // stated rows that closes wrong, and a post the register alone fills is
    // named for its closing only when the whole ties (the posts then offset
    // each other). An opening balance the books did not hold is a finding of
    // its own and is always reported.
    const postRowsOf = (post: string) => tbFullRows.filter((row) => postOfAccount(row.account_number) === post)
    const onBooks = (post: string, at: 'opening' | 'closing') =>
      postRowsOf(post).reduce(
        (sum, row) =>
          sum + (at === 'opening'
            ? (row.opening_debit || 0) - (row.opening_credit || 0)
            : (row.closing_debit || 0) - (row.closing_credit || 0)),
        0,
      )
    const booked = (at: 'opening' | 'closing') => (post: string) => {
      // Less what the ledger note discloses for the post, when its
      // write-downs beyond the register could not go in the table.
      const inLedgerNote = postRowsOf(post).filter((row) => !inTables.has(row.account_number))
      return roundOre(onBooks(post, at) - tangibleImpairmentBalance(inLedgerNote, registeredWriteDowns, at))
    }
    // A post whose figures a user stated, this year or in one before it.
    const statedPosts = new Set<string>([...Object.keys(statedRows), ...carried.keys()])
    const perPost = fixedAssetPostTieOut(fixedAssetTables, statedPosts, {
      opening: booked('opening'),
      closing: booked('closing'),
    })
    errors.push(...perPost.errors)
    // A stated omräkningsdifferens must be booked on the post's anskaffnings-
    // or avskrivningskonton. The tie of the post's value cannot see two rows
    // that cancel, so the posts that tie are checked block by block.
    errors.push(
      ...statedTranslationIssues(
        fixedAssetTables.filter((table) => table.post === null || !perPost.untiedPosts.has(table.post)),
        statedRows,
        grossMovementsByPost(tbFullRows, postOfAccount, {
          // Mark is never depreciated: the account its row names holds no avskrivningar.
          accumulated: new Set(
            assets.filter((asset) => asset.useful_life_months > 0).map((asset) => asset.bas_accumulated_account),
          ),
          writeDown: new Set(registeredWriteDowns.keys()),
        }),
      ),
    )
    if (!perPost.closingBlocked) {
      const tieOut = rollforwardTieOut(
        fixedAssetNoteCarryingTotal(fixedAssetTables),
        tbFullRows,
        holdsWriteDowns(rollforwardAssets),
        tangibleImpairmentBalance(ledgerNoteRows, registeredWriteDowns),
      )
      if (tieOut) (tieOut.blocking ? errors : warnings).push(tieOut.message)
      else warnings.push(...perPost.closingWarnings)
    }
    warnings.push(...perPost.openingWarnings)
    // A debit on the write-down accounts beyond the register prints as an
    // återföring unless a stated row says it left with an asset: say so.
    warnings.push(...unstatedWriteDownReleases(fixedAssetTables, statedRows, outsideWriteDowns))
    // Checked against the books above; a table that ties to its post's
    // accounts prints the balance sheet's own figure for the post, so the
    // note and the balance sheet show one number.
    const tables = alignCarryingWithBalanceSheet(
      fixedAssetTables,
      (post) => (postRowsOf(post).length > 0 ? roundOre(onBooks(post, 'closing')) : undefined),
      (post) => balanceSheet?.[post]?.current,
    )
    notes.push({
      number: notes.length + 1,
      title: 'Anläggningstillgångar',
      body: fixedAssetNoteBody(tables),
      fixedAssets: tables,
    })
  }
  const impairmentNote = buildTangibleImpairmentNote(ledgerNoteRows, notes.length + 1, registeredWriteDowns)
  if (impairmentNote) notes.push(impairmentNote)

  // Medelantal anställda: FTE-weighted average per ÅRL 5:20 §. We fetch the
  // full employment-window data because the column 'is_active' doesn't exist
  // on the employees table; a count() filtered by it would always return 0.
  // ÅRL 5:20 § requires the note for AB regardless of value: "0" must be
  // disclosed as "Inga anställda". For enskild firma the disclosure is
  // discretionary, so we still skip when medelantal === 0 there.
  // A manual figure on arsredovisning_narratives wins over the FTE average:
  // salary booked without a Löner employee record (hand-booked, SIE import)
  // otherwise reads as "inga anställda" although the owner drew salary.
  const medelantal = resolveMedelantalAnstallda(
    narrative?.medelantal_anstallda_override,
    (employeesResult.data ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>,
    periodStart,
    periodEnd,
  )
  if (medelantal > 0 || (isEntityType(entityType) && preparesArsredovisning(entityType))) {
    const medelantalNote = resolveMedelantalNote({
      subject: entityType === 'ekonomisk_forening' ? 'Föreningen' : 'Bolaget',
      medelantal,
      hasOverride: hasMedelantalOverride(narrative?.medelantal_anstallda_override),
      tbFullRows,
    })
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body: medelantalNote.body,
    })
    if (medelantalNote.warning) warnings.push(medelantalNote.warning)
  }

  // Långfristiga skulder förfallande efter mer än fem år (ÅRL 5:13 §).
  // Disclosed amount lives on arsredovisning_narratives as a manual entry;
  // loan-maturity data isn't tagged in journal lines so we can't derive it.
  // A null/zero value defaults to "Inga." per Swedish ÅR convention.
  const longTermDebtAmount = narrative?.long_term_debt_over_five_years ?? null
  notes.push({
    number: notes.length + 1,
    title: 'Långfristiga skulder',
    body:
      longTermDebtAmount && longTermDebtAmount > 0
        ? `Av långfristiga skulder förfaller ${longTermDebtAmount.toLocaleString('sv-SE')} kr till betalning senare än fem år efter balansdagen.`
        : 'Inga skulder förfaller till betalning senare än fem år efter balansdagen.',
  })

  // Ställda säkerheter (ÅRL 5:14 §): separate disclosure from
  // eventualförpliktelser. The register in Avtal och åtaganden writes it;
  // the manual text on arsredovisning_narratives overrides; "Inga." when
  // neither says anything (register-disclosures.ts).
  const disclosed = effectiveDisclosureTexts(narrative, registerTexts)
  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter',
    body: disclosed.securities_pledged || 'Inga.',
  })

  // Eventualförpliktelser (ÅRL 5:15 §)
  notes.push({
    number: notes.length + 1,
    title: 'Eventualförpliktelser',
    body: disclosed.contingent_liabilities || 'Inga.',
  })

  // Koncernförhållanden (BFNAR 2016:10 kap. 19). Emitted only when a parent
  // company is configured or registered: companies without one skip it.
  const parentName = disclosed.parent_company_name
  if (parentName) {
    const parts: string[] = [`Moderföretag: ${parentName}.`]
    if (disclosed.parent_company_org_number)
      parts.push(`Organisationsnummer: ${disclosed.parent_company_org_number}.`)
    if (disclosed.parent_company_city)
      parts.push(`Säte: ${disclosed.parent_company_city}.`)
    notes.push({
      number: notes.length + 1,
      title: 'Koncernförhållanden',
      body: parts.join(' '),
    })
  }

  return { notes, warnings, errors, shareCapital }
}

interface LatentTaxMovement {
  /** Uppskjuten skatteskuld (the K3 post on 2240-2249), credit-positive. */
  liability: DeferredTaxMovement
  /** Uppskjuten skattefordran (the K3 post on 1370-1379), debit-positive. */
  asset: DeferredTaxMovement
  /** The year's uppskjuten skatt in the resultaträkning (8940-8949), a cost positive. */
  expense: number
}

/** The balansräkning carries the post at the start or the end of the year. */
function holdsBalance(post: DeferredTaxMovement): boolean {
  return post.opening !== 0 || post.closing !== 0
}

const DEFERRED_TAX_EXPENSE_RANGE = { start: '8940', end: '8949' } as const

/** The BAS ranges of a K3 balance sheet post (k3-presentation.ts K3_SPLITS). */
function k3PostRanges(concept: string): ReadonlyArray<{ start: string; end: string }> {
  const split = K3_SPLITS.find((row) => row.concept === concept)
  if (!split) throw new Error(`Unknown K3 post ${concept}`)
  return split.ranges
}

/**
 * Derive the uppskjuten-skatt movement from the current-period full trial
 * balance, on the same BAS ranges as the K3 balance sheet's own posts: the
 * uppskjuten skatteskuld (2240), the uppskjuten skattefordran (1370, a
 * deductible temporary difference or a recognised loss carried forward, K3
 * 29.19 and 29.29) and the year's uppskjuten skatt in the resultaträkning
 * (8940). Each post's change is its own closing less its opening, so the note
 * ties to the balansräkning whichever side the year's deferred tax moved.
 *
 * Returns `movement: null` when the company has no such activity at all,
 * which is the normal case: a balance only appears when the K3 deferred tax
 * was posted (commit_deferred_tax books 8940 against 2240 and 1370), or from
 * legacy postings and imported history. Both the redovisningsprinciper
 * paragraph and the "Uppskjutna skatter" note are driven by this one result,
 * so they can never disagree about whether deferred tax is recognised.
 *
 * `ok: false` means the figures could not be read at all; the caller warns
 * rather than blocking the document.
 */
function deriveLatentTaxMovement(
  tbFullRows: TrialBalanceRow[],
): { ok: true; movement: LatentTaxMovement | null } | { ok: false } {
  try {
    const sum = (
      ranges: ReadonlyArray<{ start: string; end: string }>,
      pick: (row: TrialBalanceRow) => number,
    ) =>
      roundOre(
        tbFullRows
          .filter((row) => ranges.some((range) => row.account_number >= range.start && row.account_number <= range.end))
          .reduce((total, row) => total + pick(row), 0),
      )
    const balance = (ranges: ReadonlyArray<{ start: string; end: string }>, side: 'debit' | 'credit'): DeferredTaxMovement => {
      const sign = side === 'debit' ? 1 : -1
      const opening = sum(ranges, (row) => sign * ((row.opening_debit || 0) - (row.opening_credit || 0)))
      const closing = sum(ranges, (row) => sign * ((row.closing_debit || 0) - (row.closing_credit || 0)))
      return { opening, change: roundOre(closing - opening), closing }
    }
    const liability = balance(k3PostRanges('UppskjutenSkatteskuld'), 'credit')
    const asset = balance(k3PostRanges('UppskjutenSkattefordran'), 'debit')
    const expense = sum([DEFERRED_TAX_EXPENSE_RANGE], (row) => (row.period_debit || 0) - (row.period_credit || 0))
    if (!holdsBalance(liability) && !holdsBalance(asset) && expense === 0) {
      return { ok: true, movement: null }
    }
    return { ok: true, movement: { liability, asset, expense } }
  } catch {
    return { ok: false }
  }
}

/** Which deferred tax posts the balansräkning carries: none when only 8940 moved. */
function latentTaxSides(movement: LatentTaxMovement): { liability: boolean; asset: boolean } {
  return { liability: holdsBalance(movement.liability), asset: holdsBalance(movement.asset) }
}

/**
 * True when the balansräkning carries an anläggningstillgång that the
 * company's OWN chart of accounts names as leased.
 *
 * The previous rule tested for account 1260 or 1269, which was wrong in both
 * directions. It missed every other account a finance-leased asset can land
 * on (the K2 mapper folds 1220-1279 into one BR post, and the shipped BAS
 * chart carries 1217 Finansiellt leasade maskiner and 1227 Finansiellt
 * leasade inventarier), and on that same chart 1260 is "(Fritt konto för
 * Inventarier, verktyg och installationer)" and 1269 is "Ack. avskrivningar
 * på datorer": an owned laptop would have been reported as a leased asset.
 *
 * Numbers cannot separate an owned 1220 inventarie from a leased one, so ask
 * the names instead. A kontogrupp-12 account (BAS keeps capitalized leases
 * there: .claude/skills/swedish-asset-accounting/references/
 * leasing-and-disposal.md:28) whose name contains "leas" is a leased asset or
 * its accumulated depreciation; "Inventarier, verktyg och installationer"
 * never matches. Names are the right source because they travel with the
 * balance: the asset register cannot even reach 1260-1279 (its per-category
 * ranges stop at 1259 and resume at 1280), so such a balance always arrives
 * by SIE import or a manual voucher, carrying the originating chart's name.
 *
 * The scan stops at 1299 on purpose: 1720 Förutbetalda leasingavgifter is
 * part of the OPERATIONAL treatment (leasing-and-disposal.md:14) and must not
 * flip the paragraph.
 */
function hasCapitalizedLeaseAsset(tbFullRows: TrialBalanceRow[]): boolean {
  return tbFullRows.some(
    (r) =>
      r.account_number >= '1200' &&
      r.account_number < '1300' &&
      /leas/i.test(r.account_name ?? '') &&
      // closing_debit/closing_credit are cumulative per-side totals, not a
      // net balance, so a leased asset acquired earlier and disposed this
      // year has both sides non-zero while the balansrakning carries
      // nothing. Compare the NET balance so a disposed lease stops
      // triggering the paragraph.
      Math.abs((r.closing_debit || 0) - (r.closing_credit || 0)) > 0.005,
  )
}

/**
 * Build the K3 note set (BFNAR 2012:1). Differs from K2 in:
 *   - Verbose redovisningsprinciper covering all K3 measurement principles
 *   - A separate "Uppskjutna skatter" note showing 2240 movement
 *   - "Materiella anläggningstillgångar" with per-component breakdown when
 *     komponentavskrivning is used
 *   - Standard K3 placeholders for händelser efter balansdagen +
 *     eventualförpliktelser
 *
 * The aktiekapital note is shared with K2 logic: K3 punkt 18.x also
 * mandates the share-capital disclosure for AB.
 *
 * tbFullRows MUST be the FULL current-period trial balance (tbFull.rows:
 * opening balances included, year-end closing entries NOT excluded). The
 * uppskjutna-skatter note derives its BFNAR 2012:1 ch.29 opening balance,
 * movement, and closing balance for 2240/8940 from these rows; passing
 * tbPreClosing.rows would zero the opening balance and misstate the note.
 * The K3 multiyear snapshot test pins a non-zero 2240 opening balance to
 * guard this contract.
 */
async function buildK3Noter(
  supabase: SupabaseClient,
  companyId: string,
  entityType: string,
  periodStartIso: string,
  periodEndIso: string,
  narrative: NarrativeRow | null,
  tbFullRows: TrialBalanceRow[],
  fiscalPeriodId: string,
  allPeriods: PeriodRow[],
  registerTexts: RegisterDisclosureTexts | null = null,
): Promise<{ notes: NoteEntry[]; warnings: string[]; errors: string[]; assets: Asset[]; fixedAssetNoteFromRegister: boolean }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []
  const errors: string[] = []

  const isAb = entityType === 'aktiebolag'
  const maybeAb = isAb || entityType === 'unknown'

  // The three reads feeding the notes below (asset register, aktiekapital
  // settings, employee windows) are independent, so they share one parallel
  // round trip instead of three sequential ones. Note bodies, push order,
  // and numbering (notes.length + 1) are unchanged.
  const [assetsResult, settingsResult, employeesResult] = await Promise.all([
    listAssets(supabase, companyId),
    maybeAb
      ? supabase
          .from('company_settings')
          .select('aktiekapital, antal_aktier')
          .eq('company_id', companyId)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('employees')
      .select('employment_start, employment_end, employment_degree')
      .eq('company_id', companyId),
  ])

  // 1. Redovisningsprinciper. We check whether any asset has K3 components
  // configured so the principles paragraph only mentions komponentavskrivning
  // when it's actually in use.
  //
  // The stored K3 component shape on assets is
  //   { name, cost, useful_life_months, salvage_value? }
  // (per migration 20260526122000_k3_component_depreciation.sql), but the
  // note builder consumes
  //   { name, acquisition_cost, accumulated_depreciation, useful_life_months }
  // We compute accumulated_depreciation here using a linear approximation
  // (months elapsed / useful life) which matches what the per-component
  // depreciation engine (computeComponentDepreciation) produces over a year.
  // The fiscal period end is the as-of date for the depreciation snapshot.
  const assets = assetsResult as Asset[]
  const monthsBetween = (fromIso: string, toIso: string): number => {
    const from = new Date(`${fromIso}T00:00:00Z`)
    const to = new Date(`${toIso}T00:00:00Z`)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return 0
    const years = to.getUTCFullYear() - from.getUTCFullYear()
    const months = to.getUTCMonth() - from.getUTCMonth()
    const days = to.getUTCDate() - from.getUTCDate()
    let total = years * 12 + months
    if (days < 0) total -= 1
    return total
  }
  const adaptAsset = (a: Asset) => ({
    name: a.name,
    category: a.category,
    acquisition_date: a.acquisition_date,
    acquisition_cost: a.acquisition_cost,
    k3_components: Array.isArray(a.k3_components)
      ? a.k3_components.map((c) => {
          const cost = Number(c.cost) || 0
          const salvage = Number(c.salvage_value ?? 0) || 0
          const life = Number(c.useful_life_months) || 0
          const elapsed = Math.max(
            0,
            Math.min(life, monthsBetween(a.acquisition_date, periodEndIso)),
          )
          const accumulated = life > 0
            ? Math.round(((cost - salvage) * elapsed) / life)
            : 0
          return {
            name: c.name,
            acquisition_cost: cost,
            accumulated_depreciation: accumulated,
            useful_life_months: life,
          }
        })
      : null,
    disposed_at: a.disposed_at,
    useful_life_months: a.useful_life_months,
  })
  const adaptedAssets = assets.map(adaptAsset)
  const hasComponents = anyAssetHasComponents(adaptedAssets)
  // The deferred-tax figures are derived BEFORE note 1 is built, even though
  // the "Uppskjutna skatter" note is emitted further down as note 4: the
  // redovisningsprinciper paragraph has to describe the same reality that
  // note discloses. One derivation feeds both, so no code path can produce a
  // policy paragraph denying a split the following note then discloses.
  const latentTax = deriveLatentTaxMovement(tbFullRows)
  if (!latentTax.ok) {
    warnings.push(
      'Uppskjutna skatter-noten kunde inte beräknas automatiskt. Kontrollera kontona 2240, 1370 och 8940 och kör om bokslutet.',
    )
  }
  const latentTaxMovement = latentTax.ok ? latentTax.movement : null
  // Leased assets on the balance sheet contradict the blanket "all leases are
  // operational" simplification, so the same trial balance that decides the
  // deferred-tax wording also decides the leasing wording.
  const hasCapitalizedLease = hasCapitalizedLeaseAsset(tbFullRows)
  notes.push(
    buildK3RedovisningsPrinciper({
      hasComponents,
      // A read failure may not print an affirmative denial: it degrades to
      // the going-forward policy, and the warning above tells the user.
      deferredTax: !latentTax.ok
        ? 'unknown'
        : latentTaxMovement !== null
          ? 'recognized'
          : 'none',
      deferredTaxSides: latentTaxMovement ? latentTaxSides(latentTaxMovement) : undefined,
      hasCapitalizedLease,
      holdsLand: assets.some((a) => !a.disposed_at && a.category === 'land'),
    }),
  )

  // 2. Aktiekapital (shared with K2 logic: K3 punkt 18.x mandates the same
  // disclosure for AB).
  if (maybeAb) {
    type AktiekapitalShape = {
      aktiekapital?: number | null
      antal_aktier?: number | null
    }
    const ak = (settingsResult.data ?? null) as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    // Kvotvärde is defined (ABL 1 kap 6 §) as aktiekapital / antal aktier;
    // deriving it here keeps the filed note internally consistent. ÅRL
    // 5 kap 14 § requires BOTH the registered amount and the number of
    // shares, so a partial pair is treated as missing (warn, no note).
    if (aktiekapital && antalAktier) {
      const kvotvarde = roundOre(aktiekapital / antalAktier)
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: [
          `Aktiekapital: ${aktiekapital.toLocaleString('sv-SE', { maximumFractionDigits: 0 })} kr.`,
          `Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`,
          `Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`,
        ].join(' '),
      })
    } else if (isAb) {
      warnings.push(
        'Aktiekapitalnoten utelämnas eftersom uppgifter om aktiekapital saknas i Inställningar → Företag. För ett mindre företag är noten frivillig; ett större företag ska ange antal aktier och kvotvärde (ÅRL 5 kap. 34 §).',
      )
    }
  }

  // 3. Materiella anläggningstillgångar: with optional per-component
  // breakdown. The note is omitted when no tangible assets exist. Uses the
  // adapted asset list computed above so the K3-component shape matches what
  // the builder's type guard expects.
  const materialiNote = buildMateriellaAnlaggningsNot({
    noteNumber: notes.length + 1,
    assets: adaptedAssets,
  })
  if (materialiNote) notes.push(materialiNote)

  // 3b. Anläggningstillgångar roll-forward (ÅRL 5:8 §). Required even under
  // K3: K3 ch.17 layers component depreciation on top, but the basic
  // per-category roll-forward of anskaffningsvärde + ackumulerade
  // avskrivningar is the statutory baseline. Depreciation figures come
  // from posted schedules so the note ties to the balansräkning.
  const rollforwardAssets = await buildRollforwardAssets(
    supabase,
    companyId,
    assets,
    allPeriods,
    fiscalPeriodId,
  )
  const rollforwardNote = buildAnlaggningstillgangarNote({
    noteNumber: notes.length + 1,
    assets: rollforwardAssets,
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
  })
  // One source per nedskrivning (ÅRL 5 kap. 8 § p. 5): the register's in the
  // roll-forward, the rest of the ledger's write-down accounts in the note
  // below (ledger-fixed-asset-notes.ts).
  const registeredWriteDowns = registerWriteDownsByAccount(assets, periodStartIso, periodEndIso)
  if (rollforwardNote) {
    notes.push(rollforwardNote)
    const tieOut = rollforwardTieOut(
      computeRollforwardTotals(rollforwardAssets, periodStartIso, periodEndIso).ubRedovisat,
      tbFullRows,
      holdsWriteDowns(rollforwardAssets),
      tangibleImpairmentBalance(tbFullRows, registeredWriteDowns),
    )
    if (tieOut) (tieOut.blocking ? errors : warnings).push(tieOut.message)
  }
  // ÅRL 5 kap. 8 §: nedskrivningar of immateriella and materiella
  // anläggningstillgångar booked outside the register, and the finansiella
  // anläggningstillgångar the register never reaches, from the ledger.
  const impairmentNote = buildTangibleImpairmentNote(tbFullRows, notes.length + 1, registeredWriteDowns)
  if (impairmentNote) notes.push(impairmentNote)
  const financialNote = buildFinancialFixedAssetsNote(tbFullRows, notes.length + 1)
  if (financialNote) notes.push(financialNote)

  // 4. Uppskjutna skatter. K3 ch.29: the opening, movement and closing of
  // the uppskjuten skatteskuld and the uppskjuten skattefordran, and the
  // year's uppskjuten skatt. The figures were derived above
  // (deriveLatentTaxMovement) so that note 1 and this note tell the same
  // story; a null movement means no 2240, 1370 or 8940 activity exists and
  // the note is omitted.
  if (latentTaxMovement) {
    const sides = latentTaxSides(latentTaxMovement)
    notes.push(
      buildUppskjutenSkattNot({
        noteNumber: notes.length + 1,
        liability: sides.liability ? latentTaxMovement.liability : null,
        asset: sides.asset ? latentTaxMovement.asset : null,
        expense: latentTaxMovement.expense,
      }),
    )
  }

  // 5. Medelantal anställda: FTE-weighted average per ÅRL 5:20 §, or the
  // manual figure on arsredovisning_narratives when set. The note is
  // statutory for AB regardless of value (disclose "0" explicitly); for non-AB
  // entities we still skip when there are no employees.
  const medelantal = resolveMedelantalAnstallda(
    narrative?.medelantal_anstallda_override,
    (employeesResult.data ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>,
    periodStartIso,
    periodEndIso,
  )
  if (medelantal > 0 || (isEntityType(entityType) && preparesArsredovisning(entityType))) {
    const medelantalNote = resolveMedelantalNote({
      subject: entityType === 'ekonomisk_forening' ? 'Föreningen' : 'Bolaget',
      medelantal,
      hasOverride: hasMedelantalOverride(narrative?.medelantal_anstallda_override),
      tbFullRows,
    })
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body: medelantalNote.body,
    })
    if (medelantalNote.warning) warnings.push(medelantalNote.warning)
  }

  // 6. Långfristiga skulder förfallande efter mer än fem år (ÅRL 5:13 §).
  const longTermDebtAmount = narrative?.long_term_debt_over_five_years ?? null
  notes.push({
    number: notes.length + 1,
    title: 'Långfristiga skulder',
    body:
      longTermDebtAmount && longTermDebtAmount > 0
        ? `Av långfristiga skulder förfaller ${longTermDebtAmount.toLocaleString('sv-SE')} kr till betalning senare än fem år efter balansdagen.`
        : 'Inga skulder förfaller till betalning senare än fem år efter balansdagen.',
  })

  // 7. Eventualförpliktelser (K3 punkt 21: separate disclosure). The
  // register writes it, the manual text overrides (register-disclosures.ts).
  const disclosed = effectiveDisclosureTexts(narrative, registerTexts)
  notes.push({
    number: notes.length + 1,
    title: 'Eventualförpliktelser',
    body: disclosed.contingent_liabilities || 'Inga.',
  })

  // 8. Ställda säkerheter (ÅRL 5:14 §).
  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter',
    body: disclosed.securities_pledged || 'Inga.',
  })

  // 9. Koncernförhållanden (BFNAR 2012:1 kap. 8: moderföretagets namn,
  // organisationsnummer och säte). Emitted only when configured or registered.
  const parentName = disclosed.parent_company_name
  if (parentName) {
    const parts: string[] = [`Moderföretag: ${parentName}.`]
    if (disclosed.parent_company_org_number)
      parts.push(`Organisationsnummer: ${disclosed.parent_company_org_number}.`)
    if (disclosed.parent_company_city)
      parts.push(`Säte: ${disclosed.parent_company_city}.`)
    notes.push({
      number: notes.length + 1,
      title: 'Koncernförhållanden',
      body: parts.join(' '),
    })
  }

  // Väsentliga händelser efter balansdagen (ÅRL 5 kap. 22 §, K3 32.4) is a
  // disclosure the user answers: the disclosure matrix prints it
  // (disclosures/k3-mindre.ts, applied in model.ts), never a default "Inga".

  return { notes, warnings, errors, assets, fixedAssetNoteFromRegister: rollforwardNote !== null }
}

