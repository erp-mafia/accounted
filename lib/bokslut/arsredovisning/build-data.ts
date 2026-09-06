import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { LATENT_TAX_DEFAULT_RATE } from '@/lib/bokslut/tax-provision/latent-tax-calculator'
import { roundOre } from '@/lib/money'
import {
  mapTrialBalancesToK2,
  type K2MappingResult,
  type TrialBalancePair,
} from '@/lib/bokslut/ixbrl/k2-mapper'
import { buildBrRows, buildRrRows } from './statement-rows'
import { getNarrative, type NarrativeRow } from './narrative-service'
import {
  anyAssetHasComponents,
  buildEquityChangesNote,
  buildK3RedovisningsPrinciper,
  buildMateriellaAnlaggningsNot,
  buildUppskjutenSkattNot,
} from './k3-noter-builder'
import {
  buildAnlaggningstillgangarNote,
  computeRollforwardTotals,
  type AnlaggningAsset,
} from './anlaggningstillgangar-note'
import { computeAssetNoteFigures, loadPostedSchedules } from './asset-note-figures'
import { computeMedelantalAnstallda } from '@/lib/salary/medelantal'
import type {
  ArsredovisningData,
  EgenKapitalRow,
  FlerarsoversiktRow,
  NoteEntry,
  KassaflodesAnalysisSummary,
} from './types'
import type { AccountingFramework, Asset, TrialBalanceRow } from '@/types'

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
  // The RR/BR are rendered at ÅRL post level from the same K2 risbs mapping
  // that drives the iXBRL filing, never from per-account report rows.
  // Bolagsverket rejects balans-/resultaträkningar med kontonummer, so the
  // statement data must not carry account-level granularity at all. Two TB
  // variants per year (see TrialBalancePair): the FULL trial balance drives
  // the BR (2099 booked), the PRE-CLOSING one drives the RR (class 3-8
  // still open).
  const [periodResult, settingsResult, companyResult, periodList, tbFull, tbPreClosing, narrative] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, previous_period_id, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, city, entity_type')
      .eq('company_id', companyId)
      .maybeSingle(),
    // Source-of-truth for entity_type and accounting_framework lives on
    // companies. company_settings.entity_type is a legacy mirror; the
    // framework column was added later and only exists on companies.
    supabase
      .from('companies')
      .select('entity_type, accounting_framework')
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
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'include' }),
    generateTrialBalance(supabase, companyId, fiscalPeriodId, { closingEntry: 'exclude-final' }),
    // Load persisted narrative overrides: replaces the URL-query-param
    // carry from earlier phases. Caller-supplied overrides (passed in via
    // the second arg) still win, so the API can layer per-request edits on
    // top of the saved baseline if needed.
    getNarrative(supabase, companyId, fiscalPeriodId).catch(() => null),
  ])

  if (periodResult.error || !periodResult.data) {
    throw new Error('Fiscal period not found')
  }
  const period = periodResult.data
  const settings = settingsResult.data
  const companyRow = companyResult.data as
    | { entity_type?: string | null; accounting_framework?: AccountingFramework | null }
    | null
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
  // K3 is opt-in; only AB ever set it. Default to K2 when not set.
  const accountingFramework: AccountingFramework =
    companyRow?.accounting_framework === 'k3' ? 'k3' : 'k2'

  // company_settings stores the address as flat columns (address_line1,
  // postal_code, city): there is no `address` json column. Selecting one
  // made the whole settings query fail, so every ÅR fell back to "Bolaget"
  // with an empty org number.
  const city = (settings as { city?: string | null } | null)?.city ?? null

  // Previous fiscal year → jämförelsesiffror (ÅRL 3:5 §). Resolved from the
  // already-fetched period list; a TB failure downgrades to "no comparison
  // year" with a warning instead of blocking the whole document (partial SIE
  // imports can leave prior years without IB continuity).
  const statementWarnings: string[] = []
  const prevPeriodRow = period.previous_period_id
    ? ((periodList ?? []) as PeriodRow[]).find((p) => p.id === period.previous_period_id) ?? null
    : null

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
  // appropriations, and tax, excluding only the linked final result-closing
  // entry. A failed pair downgrades to null so a broken prior year (e.g. a
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
          generateTrialBalance(supabase, companyId, p.id, { closingEntry: 'include' }),
          generateTrialBalance(supabase, companyId, p.id, { closingEntry: 'exclude-final' }),
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
  const mapping = mapTrialBalancesToK2(
    { full: tbFull.rows, preClosing: tbPreClosing.rows },
    previousTb,
  )
  const previousPeriod =
    prevPeriodRow && previousTb
      ? {
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

  const flerarsoversikt = buildFlerarsoversikt(overviewSlice, fiscalPeriodId, mapping, tbPairs)

  const egen_kapital_changes = buildEquityChanges(mapping)
  const proposedDividend = narrative?.proposed_dividend ?? 0
  const retainedEarnings = mapping.br['BalanseratResultat']?.current ?? 0
  const sharePremiumReserve = mapping.br['Overkursfond']?.current ?? 0
  const currentYearResult = mapping.br['AretsResultatEgetKapital']?.current ?? 0
  const distributableEquity = mapping.totals.frittEgetKapital.current

  // Duplicate-value consistency with the RR (mirrors build-input.ts): the
  // flerårsöversikt is computed from the income statement (ALL class-3
  // revenue), but nettoomsättning per ÅRL is strictly 3000-3799. Override
  // the current + previous year so the FB table ties to the RR two pages
  // later. Older years have no RR in the document and keep the IS values.
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
  let kassaflodesanalys: KassaflodesAnalysisSummary | undefined
  let equity_changes_statement:
    | { rows: EgenKapitalRow[]; closing_total: number }
    | undefined
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
      ),
      generateKassaflodesanalys(supabase, companyId, fiscalPeriodId).then(
        (cashFlow) => ({ ok: true as const, cashFlow }),
        () => ({ ok: false as const }),
      ),
    ])
    noter = noterResult.notes
    noterWarnings = noterResult.warnings
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
        reconciliation: cashFlow.reconciliation,
      }
    } else {
      // A partial SIE import can leave 1xxx without an IB row: the report
      // throws. Surface as a warning instead of blocking the whole ÅR.
      noterWarnings.push(
        'Kassaflödesanalysen kunde inte genereras automatiskt. Kontrollera att ingående och utgående saldo på 19xx finns och kör om bokslutet.',
      )
    }

    // Equity-changes statement: derived from the post-level mapping. We
    // reuse buildEquityChangesNote's roll-forward to keep one source of
    // truth for the closing total.
    equity_changes_statement = buildK3EquityChangesStatement(mapping)
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
    )
    noter = k2Noter.notes
    noterWarnings = k2Noter.warnings
  }

  const resultatrakning = buildRrRows(mapping)
  const brRows = buildBrRows(mapping)
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
  const warnings: string[] = [...statementWarnings, ...mapping.warnings, ...noterWarnings]
  if (entityType !== 'aktiebolag' && entityType !== 'unknown') {
    warnings.push(
      'Den här årsredovisningen genereras med K2-mallen (BFNAR 2016:10) som standard. För K3- eller annan företagsform kan strukturen behöva justeras manuellt innan inlämning.',
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
    warnings.push(
      'Bolaget redovisar enligt K3 (BFNAR 2012:1). Soliditeten är beräknad med 79,4 % av obeskattade reserver inräknat i eget kapital. PDF:en innehåller '
        + (kassaflodesanalys ? 'kassaflödesanalys, förändring av eget kapital och utökade noter' : 'förändring av eget kapital och utökade noter')
        + ': granska innehållet mot er specifika redovisning innan inlämning.',
    )
  }
  if (entityType === 'unknown') {
    warnings.push(
      'Företagsform saknas i inställningarna: fyll i Inställningar → Företag för att få rätt redovisningsprinciper i not 1.',
    )
  }
  if (!persistedAgmDate) {
    warnings.push(
      'Datum för årsstämma saknas. Fastställelseintyget i PDF:en lämnas tomt på datumraden tills det fylls i nedan.',
    )
  } else {
    // ÅRL 8 kap 3 § + ÅRL 7 kap 10 §: AGM must be held after the räkenskapsår
    // ends and within 6 months of period end (för privat AB). A date before
    // period_end is logically impossible; after the deadline is a legally
    // defective fastställelseintyg.
    if (persistedAgmDate <= period.period_end) {
      warnings.push(
        `Datum för årsstämma (${persistedAgmDate}) ligger på eller före räkenskapsårets slut (${period.period_end}): fastställelseintyget blir juridiskt felaktigt. Kontrollera datumet.`,
      )
    } else {
      const periodEndDate = new Date(`${period.period_end}T00:00:00Z`)
      const deadline = new Date(periodEndDate)
      deadline.setUTCMonth(deadline.getUTCMonth() + 6)
      const deadlineIso = deadline.toISOString().slice(0, 10)
      if (persistedAgmDate > deadlineIso) {
        warnings.push(
          `Datum för årsstämma (${persistedAgmDate}) är efter 6-månadersgränsen (${deadlineIso}). För privat AB ska årsstämman hållas inom 6 månader från räkenskapsårets slut (ÅRL 7 kap 10 §).`,
        )
      }
    }
  }

  return {
    company: {
      name: companyName,
      org_number: orgNumber,
      entity_type: entityType,
      city,
    },
    fiscal_period: {
      id: period.id,
      name: period.name,
      period_start: period.period_start,
      period_end: period.period_end,
    },
    previous_period: previousPeriod,
    accounting_framework: accountingFramework,
    forvaltningsberattelse: {
      description:
        overrides.description ??
        persistedDescription ??
        `${companyName} bedriver verksamhet enligt verksamhetsbeskrivningen i bolagsordningen.`,
      important_events:
        overrides.important_events ??
        persistedEvents ??
        'Inga väsentliga händelser utöver löpande verksamhet har inträffat under räkenskapsåret.',
      kontrollbalans_required: overrides.kontrollbalans_required ?? false,
      flerarsoversikt,
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
      agm_disposition_outcome: narrative?.agm_disposition_outcome ?? null,
      agm_disposition_decision: narrative?.agm_disposition_decision ?? null,
    },
    resultatrakning,
    warnings,
    balansrakning,
    noter,
    kassaflodesanalys,
    equity_changes_statement,
    signatures: [], // populated by signature-flow service in a later phase step
    disclosures: {
      long_term_debt_over_five_years: narrative?.long_term_debt_over_five_years ?? null,
      securities_pledged: narrative?.securities_pledged ?? null,
      contingent_liabilities: narrative?.contingent_liabilities ?? null,
      parent_company_name: narrative?.parent_company_name ?? null,
      parent_company_org_number: narrative?.parent_company_org_number ?? null,
      parent_company_city: narrative?.parent_company_city ?? null,
      confirmations: {
        long_term_debt_over_five_years:
          narrative?.long_term_debt_over_five_years_confirmed ?? false,
        securities_pledged: narrative?.securities_pledged_confirmed ?? false,
        contingent_liabilities: narrative?.contingent_liabilities_confirmed ?? false,
        parent_company: narrative?.parent_company_confirmed ?? false,
      },
    },
  }
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
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
): FlerarsoversiktRow[] {
  const rows: FlerarsoversiktRow[] = []
  for (const p of overviewSlice) {
    try {
      let mapping = currentMapping
      if (p.id !== currentPeriodId) {
        const pair = tbPairs.get(p.id)
        if (!pair) throw new Error('trial balance unavailable')
        mapping = mapTrialBalancesToK2(pair, null)
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

/**
 * Förvaltningsberättelsens "Förändring av eget kapital" table, post-level
 * labels only (no kontonummer). Only genuine equity posts (20xx) appear;
 * obeskattade reserver are NOT eget kapital and were dropped from the table
 * when the account-row version was replaced by the mapping-driven one.
 */
function buildEquityChanges(mapping: K2MappingResult): EgenKapitalRow[] {
  const posts: Array<{ label: string; concept: string; alwaysShow?: boolean }> = [
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
  const schedules = await loadPostedSchedules(supabase, companyId)
  const figures = computeAssetNoteFigures({
    assets,
    postedSchedules: schedules,
    fiscalPeriods: allPeriods,
    currentPeriodId: fiscalPeriodId,
  })
  return assets.map((a) => ({
    category: a.category,
    acquisition_date: a.acquisition_date,
    acquisition_cost: a.acquisition_cost,
    salvage_value: a.salvage_value,
    useful_life_months: a.useful_life_months,
    disposed_at: a.disposed_at,
    figures: figures.get(a.id) ?? { ibAck: 0, aretsAvskrivning: 0, avgaendeAck: 0 },
  }))
}

/**
 * Cross-check the roll-forward note's closing book value against the
 * balansräkning (full TB net of accounts 1000-1299: immateriella +
 * materiella anläggningstillgångar; 13xx financial assets are outside the
 * note). Returns a user-facing warning when they diverge by more than 1 kr,
 * which is the exact inconsistency ÅRL 5:8 § forbids in a filed document.
 */
function rollforwardTieOutWarning(
  rollforwardAssets: AnlaggningAsset[],
  tbFullRows: TrialBalanceRow[],
  periodStart: string,
  periodEnd: string,
): string | null {
  const totals = computeRollforwardTotals(rollforwardAssets, periodStart, periodEnd)
  const tbNet = tbFullRows
    .filter((r) => r.account_number >= '1000' && r.account_number < '1300')
    .reduce((sum, r) => sum + (r.closing_debit || 0) - (r.closing_credit || 0), 0)
  if (Math.abs(totals.ubRedovisat - tbNet) <= 1) return null
  const fmtKr = (n: number) => Math.round(n).toLocaleString('sv-SE')
  return `Anläggningsnotens utgående redovisade värde (${fmtKr(totals.ubRedovisat)} kr) stämmer inte med balansräkningens bokförda värde för konto 1000-1299 (${fmtKr(tbNet)} kr). Kontrollera att anläggningsregistret är komplett och att årets avskrivningar är bokförda.`
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
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []
  // Note 1: framework. Only claim K2 explicitly when we know the company is
  // an AB and using K2: otherwise emit a generic principles note so the
  // ÅR doesn't falsely assert a framework the company isn't on.
  // K3 election isn't yet tracked separately; we treat any non-AB as not-K2.
  const isAbK2 = entityType === 'aktiebolag'
  notes.push({
    number: 1,
    title: 'Redovisnings- och värderingsprinciper',
    body: isAbK2
      ? 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd BFNAR 2016:10 Årsredovisning i mindre företag (K2).'
      : 'Årsredovisningen är upprättad i enlighet med Årsredovisningslagen och Bokföringsnämndens allmänna råd.',
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
  // disclosure; the statutory ÅRL 5:8 § roll-forward follows below).
  if (assets.length > 0) {
    const byCategory = new Map<string, Set<number>>()
    for (const a of assets) {
      if (a.disposed_at) continue
      const years = Math.round(a.useful_life_months / 12)
      if (!byCategory.has(a.category)) byCategory.set(a.category, new Set())
      byCategory.get(a.category)!.add(years)
    }
    if (byCategory.size > 0) {
      const lines: string[] = ['Avskrivningar görs linjärt över bedömd nyttjandeperiod:']
      const categoryLabels: Record<string, string> = {
        immaterial: 'Immateriella anläggningstillgångar',
        building: 'Byggnader',
        land_improvement: 'Markanläggningar',
        machinery: 'Maskiner',
        equipment: 'Inventarier',
        vehicle: 'Fordon',
        computer: 'Datorer',
        other_tangible: 'Övriga materiella anläggningstillgångar',
      }
      for (const [cat, yearsSet] of byCategory.entries()) {
        const yrs = Array.from(yearsSet).sort((a, b) => a - b)
        const yrsLabel = yrs.length === 1 ? `${yrs[0]} år` : `${yrs[0]}-${yrs[yrs.length - 1]} år`
        lines.push(`• ${categoryLabels[cat] ?? cat}: ${yrsLabel}`)
      }
      notes.push({
        number: notes.length + 1,
        title: 'Avskrivningar',
        body: lines.join('\n'),
      })
    }
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
  const rollforwardNote = buildAnlaggningstillgangarNote({
    noteNumber: notes.length + 1,
    assets: rollforwardAssets,
    periodStart,
    periodEnd,
  })
  if (rollforwardNote) {
    notes.push(rollforwardNote)
    const tieOut = rollforwardTieOutWarning(
      rollforwardAssets,
      tbFullRows,
      periodStart,
      periodEnd,
    )
    if (tieOut) warnings.push(tieOut)
  }

  // Medelantal anställda: FTE-weighted average per ÅRL 5:20 §. We fetch the
  // full employment-window data because the column 'is_active' doesn't exist
  // on the employees table; a count() filtered by it would always return 0.
  // ÅRL 5:20 § requires the note for AB regardless of value: "0" must be
  // disclosed as "Inga anställda". For enskild firma the disclosure is
  // discretionary, so we still skip when medelantal === 0 there.
  const medelantal = computeMedelantalAnstallda(
    (employeesResult.data ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>,
    periodStart,
    periodEnd,
  )
  if (medelantal > 0 || entityType === 'aktiebolag') {
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body:
        medelantal > 0
          ? `Under räkenskapsåret har medeltalet anställda uppgått till ${medelantal}.`
          : 'Bolaget har inte haft några anställda under räkenskapsåret.',
    })
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
  // eventualförpliktelser. Manual override on arsredovisning_narratives,
  // defaulting to "Inga.".
  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter',
    body: narrative?.securities_pledged?.trim() || 'Inga.',
  })

  // Eventualförpliktelser (ÅRL 5:15 §)
  notes.push({
    number: notes.length + 1,
    title: 'Eventualförpliktelser',
    body: narrative?.contingent_liabilities?.trim() || 'Inga.',
  })

  // Koncernförhållanden (BFNAR 2016:10 kap. 19). Emitted only when a parent
  // company is configured: companies without a parent skip this note.
  const parentName = narrative?.parent_company_name?.trim()
  if (parentName) {
    const parts: string[] = [`Moderföretag: ${parentName}.`]
    if (narrative?.parent_company_org_number)
      parts.push(`Organisationsnummer: ${narrative.parent_company_org_number}.`)
    if (narrative?.parent_company_city)
      parts.push(`Säte: ${narrative.parent_company_city}.`)
    notes.push({
      number: notes.length + 1,
      title: 'Koncernförhållanden',
      body: parts.join(' '),
    })
  }

  return { notes, warnings }
}

interface LatentTaxMovement {
  /** Opening balance on 2240 (credit-normal, so positive = liability). */
  opening: number
  /** Year movement, taken from 8940 when the account was used. */
  change: number
  /** Closing balance on 2240. */
  closing: number
}

/**
 * Derive the uppskjuten-skatt movement from the current-period full trial
 * balance: 2240 (latent tax liability) and 8940 (latent tax expense).
 *
 * Returns `movement: null` when the company has no such activity at all,
 * which is the normal case: a 2240 balance only appears when the K3
 * uppskjuten-skatt disposition was posted, or from legacy postings and
 * imported history. Both the redovisningsprinciper paragraph and the
 * "Uppskjutna skatter" note are driven by this one result, so they can never
 * disagree about whether a deferred tax on obeskattade reserver is
 * separately recognized.
 *
 * `ok: false` means the figures could not be read at all; the caller warns
 * rather than blocking the document.
 */
function deriveLatentTaxMovement(
  tbFullRows: TrialBalanceRow[],
): { ok: true; movement: LatentTaxMovement | null } | { ok: false } {
  try {
    const row2240 = tbFullRows.find((r) => r.account_number === '2240')
    const row8940 = tbFullRows.find((r) => r.account_number === '8940')
    // 2240 is credit-normal liability: opening = opening_credit - opening_debit
    const opening2240 = row2240
      ? (row2240.opening_credit || 0) - (row2240.opening_debit || 0)
      : 0
    const closing2240 = row2240
      ? (row2240.closing_credit || 0) - (row2240.closing_debit || 0)
      : 0
    // 8940 is an expense (debit-normal): movement = period_debit - period_credit
    // A positive movement = additional avsättning (cost incurred = liability
    // grew). The 2240 balance moves by the same magnitude (with opposite
    // sign convention since 2240 is on the credit side).
    const change8940 = row8940
      ? (row8940.period_debit || 0) - (row8940.period_credit || 0)
      : closing2240 - opening2240
    if (opening2240 === 0 && closing2240 === 0 && change8940 === 0) {
      return { ok: true, movement: null }
    }
    return {
      ok: true,
      movement: {
        opening: opening2240,
        change: change8940,
        closing: closing2240,
      },
    }
  } catch {
    return { ok: false }
  }
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
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []

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
      'Uppskjutna skatter-noten kunde inte beräknas automatiskt. Kontrollera kontot 2240 och kör om bokslutet.',
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
      hasCapitalizedLease,
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
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K3 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
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
  if (rollforwardNote) {
    notes.push(rollforwardNote)
    const tieOut = rollforwardTieOutWarning(
      rollforwardAssets,
      tbFullRows,
      periodStartIso,
      periodEndIso,
    )
    if (tieOut) warnings.push(tieOut)
  }

  // 4. Uppskjutna skatter. K3 ch.29 requires disclosure of opening,
  // movement, and closing balance of uppskjuten skatteskuld. The figures
  // were derived above (deriveLatentTaxMovement) so that note 1 and this
  // note tell the same story; a null movement means no 2240/8940 activity
  // exists and the note is omitted.
  if (latentTaxMovement) {
    notes.push(
      buildUppskjutenSkattNot({
        noteNumber: notes.length + 1,
        latentTaxOpening: latentTaxMovement.opening,
        latentTaxChange: latentTaxMovement.change,
        latentTaxClosing: latentTaxMovement.closing,
      }),
    )
  }

  // 5. Medelantal anställda: FTE-weighted average per ÅRL 5:20 §. The note is
  // statutory for AB regardless of value (disclose "0" explicitly); for non-AB
  // entities we still skip when there are no employees.
  const medelantal = computeMedelantalAnstallda(
    (employeesResult.data ?? []) as Array<{
      employment_start: string
      employment_end: string | null
      employment_degree: number
    }>,
    periodStartIso,
    periodEndIso,
  )
  if (medelantal > 0 || entityType === 'aktiebolag') {
    notes.push({
      number: notes.length + 1,
      title: 'Medelantal anställda',
      body:
        medelantal > 0
          ? `Under räkenskapsåret har medeltalet anställda uppgått till ${medelantal}.`
          : 'Bolaget har inte haft några anställda under räkenskapsåret.',
    })
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

  // 7. Eventualförpliktelser (K3 punkt 21: separate disclosure).
  notes.push({
    number: notes.length + 1,
    title: 'Eventualförpliktelser',
    body: narrative?.contingent_liabilities?.trim() || 'Inga.',
  })

  // 8. Ställda säkerheter (ÅRL 5:14 §).
  notes.push({
    number: notes.length + 1,
    title: 'Ställda säkerheter',
    body: narrative?.securities_pledged?.trim() || 'Inga.',
  })

  // 9. Koncernförhållanden (BFNAR 2012:1 kap. 8: moderföretagets namn,
  // organisationsnummer och säte). Emitted only when configured.
  const parentName = narrative?.parent_company_name?.trim()
  if (parentName) {
    const parts: string[] = [`Moderföretag: ${parentName}.`]
    if (narrative?.parent_company_org_number)
      parts.push(`Organisationsnummer: ${narrative.parent_company_org_number}.`)
    if (narrative?.parent_company_city)
      parts.push(`Säte: ${narrative.parent_company_city}.`)
    notes.push({
      number: notes.length + 1,
      title: 'Koncernförhållanden',
      body: parts.join(' '),
    })
  }

  // 10. Väsentliga händelser efter balansdagen (K3 ch.32)
  notes.push({
    number: notes.length + 1,
    title: 'Väsentliga händelser efter balansdagen',
    body: 'Inga väsentliga händelser har inträffat efter räkenskapsårets utgång som påverkar bedömningen av företagets ställning och resultat.',
  })

  return { notes, warnings }
}

/**
 * K3 separate "Förändring av eget kapital" statement, derived from the
 * post-level mapping. With a previous fiscal year the opening balances are
 * the REAL prior-year UB values (mapping .previous), and the year's
 * movements are derived so the roll-forward ties exactly to the booked UB:
 * bundet-EK growth is presented as nyemission, a fritt-EK shortfall beyond
 * årets resultat as utdelning (the overwhelmingly common cases; a positive
 * fritt residual, e.g. aktieägartillskott, is folded into nyemission
 * rather than invent an unbookable row). First fiscal year falls back to
 * opening = closing - årets resultat.
 */
function buildK3EquityChangesStatement(
  mapping: K2MappingResult,
): { rows: EgenKapitalRow[]; closing_total: number } {
  const cur = (concept: string): number => mapping.br[concept]?.current ?? 0
  const prev = (concept: string): number => mapping.br[concept]?.previous ?? 0

  const aretsResultat = cur('AretsResultatEgetKapital')
  const aktiekapitalClosing = cur('Aktiekapital') + cur('EjRegistreratAktiekapital')
  const bundnaClosing = mapping.totals.bundetEgetKapital.current - aktiekapitalClosing
  const frittClosing = mapping.totals.frittEgetKapital.current

  const hasPrevious = mapping.totals.egetKapital.previous !== null
  let opening: { aktiekapital: number; bundna_reserver: number; balanserade_vinstmedel: number }
  let nyemission = 0
  let utdelning = 0
  if (hasPrevious) {
    const aktiekapitalOpening = prev('Aktiekapital') + prev('EjRegistreratAktiekapital')
    const bundnaOpening =
      (mapping.totals.bundetEgetKapital.previous ?? 0) - aktiekapitalOpening
    const frittOpening = mapping.totals.frittEgetKapital.previous ?? 0
    opening = {
      aktiekapital: aktiekapitalOpening,
      bundna_reserver: bundnaOpening,
      balanserade_vinstmedel: frittOpening,
    }
    nyemission =
      aktiekapitalClosing - aktiekapitalOpening + (bundnaClosing - bundnaOpening)
    const frittResidual = frittClosing - frittOpening - aretsResultat
    if (frittResidual < 0) utdelning = frittResidual
    else nyemission += frittResidual
  } else {
    opening = {
      aktiekapital: aktiekapitalClosing,
      bundna_reserver: bundnaClosing,
      balanserade_vinstmedel: frittClosing - aretsResultat,
    }
  }
  return buildEquityChangesNote({
    opening,
    changes: { nyemission, utdelning, arets_resultat: aretsResultat },
  })
}

