import type { SupabaseClient } from '@supabase/supabase-js'
import { generateIncomeStatement } from '@/lib/reports/income-statement'
import { generateBalanceSheet } from '@/lib/reports/balance-sheet'
import { generateTrialBalance } from '@/lib/reports/trial-balance'
import { generateKassaflodesanalys } from '@/lib/reports/kassaflodesanalys'
import { listAssets } from '@/lib/bokslut/assets/asset-service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { LATENT_TAX_DEFAULT_RATE } from '@/lib/bokslut/tax-provision/latent-tax-calculator'
import { getNarrative, type NarrativeRow } from './narrative-service'
import {
  anyAssetHasComponents,
  buildEquityChangesNote,
  buildK3RedovisningsPrinciper,
  buildMateriellaAnlaggningsNot,
  buildUppskjutenSkattNot,
} from './k3-noter-builder'
import { buildAnlaggningstillgangarNote } from './anlaggningstillgangar-note'
import { computeMedelantalAnstallda } from '@/lib/salary/medelantal'
import type {
  ArsredovisningData,
  EgenKapitalRow,
  FlerarsoversiktRow,
  IncomeStatementLine,
  BalanceSheetLine,
  NoteEntry,
  KassaflodesAnalysisSummary,
} from './types'
import type {
  AccountingFramework,
  Asset,
  BalanceSheetSection,
  IncomeStatementSection,
} from '@/types'

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
  const [periodResult, settingsResult, companyResult, periodList, incomeStatement, balanceSheet, narrative] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('id, name, period_start, period_end, previous_period_id, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    supabase
      .from('company_settings')
      .select('company_name, org_number, address, entity_type')
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
    generateIncomeStatement(supabase, companyId, fiscalPeriodId),
    generateBalanceSheet(supabase, companyId, fiscalPeriodId),
    // Load persisted narrative overrides — replaces the URL-query-param
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
  // Default to 'unknown' (not 'aktiebolag') when entity_type isn't set —
  // otherwise the K2 guard in buildK2Noter would claim K2 for every
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

  type AddressShape = { city?: string | null; postal_city?: string | null } | null
  const addressUnknown = (settings as { address?: AddressShape } | null)?.address ?? null
  const city =
    (addressUnknown && (addressUnknown.city ?? addressUnknown.postal_city)) || null

  // Merge precedence: caller overrides → persisted narrative → boilerplate
  const persistedDescription = narrative?.description ?? undefined
  const persistedEvents = narrative?.important_events ?? undefined
  const persistedRd = narrative?.resultatdisposition ?? undefined
  const persistedAgmDate = narrative?.agm_date ?? null

  const flerarsoversikt = await buildFlerarsoversikt(
    supabase,
    companyId,
    fiscalPeriodId,
    (periodList ?? []) as Array<{ id: string; name: string; period_start: string; period_end: string }>,
    accountingFramework,
  )

  const egen_kapital_changes = buildEquityChanges(balanceSheet.equity_liability_sections)

  // K3 vs K2 split: K3 has a richer note set + a kassaflöde + a separate
  // equity-changes statement. The 18a/b warning that flagged "K3 noter not
  // yet emitted" is removed below now that we actually emit them.
  const { notes: noter, warnings: noterWarnings } =
    accountingFramework === 'k3'
      ? await buildK3Noter(
          supabase,
          companyId,
          fiscalPeriodId,
          entityType,
          period.period_start,
          period.period_end,
          narrative,
        )
      : await buildK2Noter(
          supabase,
          companyId,
          entityType,
          period.period_start,
          period.period_end,
          narrative,
        )

  // Kassaflödesanalys + separate equity-changes statement — K3 only. K2
  // mindre företag is exempt from kassaflödesanalys (BFNAR 2016:10 punkt
  // 5.2) and keeps equity changes inside förvaltningsberättelsen.
  let kassaflodesanalys: KassaflodesAnalysisSummary | undefined
  let equity_changes_statement:
    | { rows: EgenKapitalRow[]; closing_total: number }
    | undefined
  if (accountingFramework === 'k3') {
    try {
      const cashFlow = await generateKassaflodesanalys(
        supabase,
        companyId,
        fiscalPeriodId,
      )
      // Strip fiscal_period_id from the embedded report — period info is
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
    } catch {
      // A partial SIE import can leave 1xxx without an IB row — the report
      // throws. Surface as a warning instead of blocking the whole ÅR.
      noterWarnings.push(
        'Kassaflödesanalysen kunde inte genereras automatiskt. Kontrollera att ingående och utgående saldo på 19xx finns och kör om bokslutet.',
      )
    }

    // Equity-changes statement — derived from the saved equity rows + this
    // year's resultat. We reuse buildEquityChangesNote's roll-forward to
    // keep one source of truth for the closing total.
    equity_changes_statement = buildK3EquityChangesStatement(
      balanceSheet.equity_liability_sections,
      incomeStatement.net_result,
    )
  }

  const resultatrakning = flattenIncomeStatement(incomeStatement)
  const balansrakning = flattenBalanceSheet(balanceSheet)

  const warnings: string[] = [...noterWarnings]
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
    warnings.push(
      'Bolaget redovisar enligt K3 (BFNAR 2012:1). Soliditeten är beräknad med 79,4 % av obeskattade reserver inräknat i eget kapital. PDF:en innehåller kassaflödesanalys, förändring av eget kapital och utökade noter — granska innehållet mot er specifika redovisning innan inlämning.',
    )
  }
  if (entityType === 'unknown') {
    warnings.push(
      'Företagsform saknas i inställningarna — fyll i Inställningar → Företag för att få rätt redovisningsprinciper i not 1.',
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
        `Datum för årsstämma (${persistedAgmDate}) ligger på eller före räkenskapsårets slut (${period.period_end}) — fastställelseintyget blir juridiskt felaktigt. Kontrollera datumet.`,
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
      city,
    },
    fiscal_period: {
      id: period.id,
      name: period.name,
      period_start: period.period_start,
      period_end: period.period_end,
    },
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
      agm_date: persistedAgmDate,
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
    },
  }
}

interface PeriodRow {
  id: string
  name: string
  period_start: string
  period_end: string
}

async function buildFlerarsoversikt(
  supabase: SupabaseClient,
  companyId: string,
  currentPeriodId: string,
  allPeriods: PeriodRow[],
  accountingFramework: AccountingFramework,
): Promise<FlerarsoversiktRow[]> {
  // Take the current period + 3 prior (oldest first).
  const sorted = [...allPeriods].sort((a, b) => a.period_start.localeCompare(b.period_start))
  const currentIdx = sorted.findIndex((p) => p.id === currentPeriodId)
  if (currentIdx === -1) return []
  const slice = sorted.slice(Math.max(0, currentIdx - 3), currentIdx + 1)

  const rows: FlerarsoversiktRow[] = []
  for (const p of slice) {
    try {
      const [is, tb] = await Promise.all([
        generateIncomeStatement(supabase, companyId, p.id),
        generateTrialBalance(supabase, companyId, p.id),
      ])
      // Nettoomsättning = sum of revenue sections (revenue is normally credit).
      const netRevenue = is.total_revenue
      const resultAfterFinancial = is.total_revenue - is.total_expenses + is.total_financial
      const totalAssets = tb.rows
        .filter((r) => r.account_class === 1)
        .reduce((s, r) => s + (r.closing_debit - r.closing_credit), 0)
      const eqLiab = tb.rows
        .filter((r) => r.account_class === 2)
        .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)
      // Soliditet differs by framework:
      //   K2 (ÅRL / BFNAR 2016:10): 20xx only. 21xx (periodiseringsfonder,
      //   överavskrivningar) are obeskattade reserver — partially deferred
      //   tax, not equity. Including 21xx would inflate soliditet for any AB
      //   that posts dispositions.
      //
      //   K3 (BFNAR 2012:1) splits 21xx into 79,4 % equity + 20,6 % latent
      //   skatteskuld. Account 2240 holds the latent tax liability and is
      //   already classified as a liability via class 2 / account_group 22,
      //   so the soliditet add-on is just the equity portion of 21xx. (We
      //   do NOT double-count 2240 here — the trial balance row for 2240
      //   already lives in eqLiab as a liability.)
      const baseEquity = tb.rows
        .filter((r) => r.account_number.startsWith('20'))
        .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)
      let equity = baseEquity
      if (accountingFramework === 'k3') {
        const obeskattadeReserver = tb.rows
          .filter((r) => r.account_number.startsWith('21'))
          .reduce((s, r) => s + (r.closing_credit - r.closing_debit), 0)
        equity += obeskattadeReserver * (1 - LATENT_TAX_DEFAULT_RATE)
      }
      const soliditet =
        totalAssets > 0 ? Math.round((equity / totalAssets) * 1000) / 10 : null
      // Avoid the unused-variable warning while leaving eqLiab computed for
      // future "Skulder" column expansion.
      void eqLiab
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

function buildEquityChanges(sections: BalanceSheetSection[]): EgenKapitalRow[] {
  const equity: EgenKapitalRow[] = []
  for (const section of sections) {
    for (const row of section.rows) {
      if (
        row.account_number.startsWith('20') ||
        row.account_number.startsWith('21')
      ) {
        equity.push({
          label: `${row.account_number} ${row.account_name}`,
          amount: row.amount,
        })
      }
    }
  }
  return equity
}

async function buildK2Noter(
  supabase: SupabaseClient,
  companyId: string,
  entityType: string,
  periodStart: string,
  periodEnd: string,
  narrative: NarrativeRow | null,
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []
  // Note 1: framework. Only claim K2 explicitly when we know the company is
  // an AB and using K2 — otherwise emit a generic principles note so the
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
  // an AB the user just hasn't configured yet — staying silent would let
  // them download an incomplete K2 ÅR without realising.
  const maybeAb = isAbK2 || entityType === 'unknown'
  if (maybeAb) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('aktiekapital, antal_aktier, kvotvarde')
      .eq('company_id', companyId)
      .maybeSingle()
    type AktiekapitalShape = { aktiekapital?: number | null; antal_aktier?: number | null; kvotvarde?: number | null }
    const ak = settings as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    const kvotvarde = ak?.kvotvarde ?? null
    if (aktiekapital || antalAktier) {
      const parts: string[] = []
      if (aktiekapital) parts.push(`Aktiekapital: ${aktiekapital.toLocaleString('sv-SE')} kr.`)
      if (antalAktier) parts.push(`Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`)
      if (kvotvarde) parts.push(`Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`)
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: parts.join(' '),
      })
    } else {
      // Don't write a "saknas — komplettera" placeholder into the PDF body —
      // that text would land in the Bolagsverket-filed document as a user-
      // facing error string and the filing would be K2-non-compliant
      // (BFNAR 2016:10 punkt 5.4 / ÅRL 5 kap 14 § require the actual
      // registered amount). Omit the note entirely and surface a warning so
      // the UI can flag this pre-download.
      warnings.push(
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K2 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
      )
    }
  }

  // Avskrivningstider — derive from asset register (supplementary
  // disclosure; the statutory ÅRL 5:8 § roll-forward follows below).
  const assets = await listAssets(supabase, companyId)
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
        const yrsLabel = yrs.length === 1 ? `${yrs[0]} år` : `${yrs[0]}–${yrs[yrs.length - 1]} år`
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
  // for any company with assets on the books.
  const rollforwardNote = buildAnlaggningstillgangarNote({
    noteNumber: notes.length + 1,
    assets: assets.map((a) => ({
      category: a.category,
      acquisition_date: a.acquisition_date,
      acquisition_cost: a.acquisition_cost,
      salvage_value: a.salvage_value,
      useful_life_months: a.useful_life_months,
      disposed_at: a.disposed_at,
    })),
    periodStart,
    periodEnd,
  })
  if (rollforwardNote) notes.push(rollforwardNote)

  // Medelantal anställda — FTE-weighted average per ÅRL 5:20 §. We fetch the
  // full employment-window data because the column 'is_active' doesn't exist
  // on the employees table; a count() filtered by it would always return 0.
  // ÅRL 5:20 § requires the note for AB regardless of value — "0" must be
  // disclosed as "Inga anställda". For enskild firma the disclosure is
  // discretionary, so we still skip when medelantal === 0 there.
  const { data: employeeRows } = await supabase
    .from('employees')
    .select('employment_start, employment_end, employment_degree')
    .eq('company_id', companyId)
  const medelantal = computeMedelantalAnstallda(
    (employeeRows ?? []) as Array<{
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

  // Ställda säkerheter (ÅRL 5:14 §) — separate disclosure from
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
  // company is configured — companies without a parent skip this note.
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

/**
 * Build the K3 note set (BFNAR 2012:1). Differs from K2 in:
 *   - Verbose redovisningsprinciper covering all K3 measurement principles
 *   - A separate "Uppskjutna skatter" note showing 2240 movement
 *   - "Materiella anläggningstillgångar" with per-component breakdown when
 *     komponentavskrivning is used
 *   - Standard K3 placeholders for händelser efter balansdagen +
 *     eventualförpliktelser
 *
 * The aktiekapital note is shared with K2 logic — K3 punkt 18.x also
 * mandates the share-capital disclosure for AB.
 */
async function buildK3Noter(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  entityType: string,
  periodStartIso: string,
  periodEndIso: string,
  narrative: NarrativeRow | null,
): Promise<{ notes: NoteEntry[]; warnings: string[] }> {
  const notes: NoteEntry[] = []
  const warnings: string[] = []

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
  const assets = (await listAssets(supabase, companyId)) as Asset[]
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
  notes.push(buildK3RedovisningsPrinciper(hasComponents))

  // 2. Aktiekapital (shared with K2 logic — K3 punkt 18.x mandates the same
  // disclosure for AB).
  const isAb = entityType === 'aktiebolag'
  const maybeAb = isAb || entityType === 'unknown'
  if (maybeAb) {
    const { data: settings } = await supabase
      .from('company_settings')
      .select('aktiekapital, antal_aktier, kvotvarde')
      .eq('company_id', companyId)
      .maybeSingle()
    type AktiekapitalShape = {
      aktiekapital?: number | null
      antal_aktier?: number | null
      kvotvarde?: number | null
    }
    const ak = settings as AktiekapitalShape | null
    const aktiekapital = ak?.aktiekapital ?? null
    const antalAktier = ak?.antal_aktier ?? null
    const kvotvarde = ak?.kvotvarde ?? null
    if (aktiekapital || antalAktier) {
      const parts: string[] = []
      if (aktiekapital) parts.push(`Aktiekapital: ${aktiekapital.toLocaleString('sv-SE')} kr.`)
      if (antalAktier) parts.push(`Antal aktier: ${antalAktier.toLocaleString('sv-SE')}.`)
      if (kvotvarde) parts.push(`Kvotvärde per aktie: ${kvotvarde.toLocaleString('sv-SE')} kr.`)
      notes.push({
        number: notes.length + 1,
        title: 'Aktiekapital',
        body: parts.join(' '),
      })
    } else if (isAb) {
      warnings.push(
        'Aktiekapitalnoten saknas eftersom uppgifter om aktiekapital inte finns i Inställningar → Företag. K3 / ÅRL kräver att noten innehåller registrerat belopp innan inlämning till Bolagsverket.',
      )
    }
  }

  // 3. Materiella anläggningstillgångar — with optional per-component
  // breakdown. The note is omitted when no tangible assets exist. Uses the
  // adapted asset list computed above so the K3-component shape matches what
  // the builder's type guard expects.
  const materialiNote = buildMateriellaAnlaggningsNot({
    noteNumber: notes.length + 1,
    assets: adaptedAssets,
  })
  if (materialiNote) notes.push(materialiNote)

  // 3b. Anläggningstillgångar roll-forward (ÅRL 5:8 §). Required even under
  // K3 — K3 ch.17 layers component depreciation on top, but the basic
  // per-category roll-forward of anskaffningsvärde + ackumulerade
  // avskrivningar is the statutory baseline.
  const rollforwardNote = buildAnlaggningstillgangarNote({
    noteNumber: notes.length + 1,
    assets: assets.map((a) => ({
      category: a.category,
      acquisition_date: a.acquisition_date,
      acquisition_cost: a.acquisition_cost,
      salvage_value: a.salvage_value,
      useful_life_months: a.useful_life_months,
      disposed_at: a.disposed_at,
    })),
    periodStart: periodStartIso,
    periodEnd: periodEndIso,
  })
  if (rollforwardNote) notes.push(rollforwardNote)

  // 4. Uppskjutna skatter. K3 ch.29 requires disclosure of opening,
  // movement, and closing balance of uppskjuten skatteskuld. We derive
  // these from the trial balance for 2240 (latent tax liability) and
  // 8940 (latent tax expense).
  try {
    const { rows } = await generateTrialBalance(supabase, companyId, fiscalPeriodId)
    const row2240 = rows.find((r) => r.account_number === '2240')
    const row8940 = rows.find((r) => r.account_number === '8940')
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
    if (opening2240 !== 0 || closing2240 !== 0 || change8940 !== 0) {
      notes.push(
        buildUppskjutenSkattNot({
          noteNumber: notes.length + 1,
          latentTaxOpening: opening2240,
          latentTaxChange: change8940,
          latentTaxClosing: closing2240,
        }),
      )
    }
  } catch {
    // Trial-balance failure should not block the document; flag as warning.
    warnings.push(
      'Uppskjutna skatter-noten kunde inte beräknas automatiskt. Kontrollera kontot 2240 och kör om bokslutet.',
    )
  }

  // 5. Medelantal anställda — FTE-weighted average per ÅRL 5:20 §. The note is
  // statutory for AB regardless of value (disclose "0" explicitly); for non-AB
  // entities we still skip when there are no employees.
  const { data: employeeRows } = await supabase
    .from('employees')
    .select('employment_start, employment_end, employment_degree')
    .eq('company_id', companyId)
  const medelantal = computeMedelantalAnstallda(
    (employeeRows ?? []) as Array<{
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

  // 7. Eventualförpliktelser (K3 punkt 21 — separate disclosure).
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

  // 9. Koncernförhållanden (BFNAR 2012:1 kap. 8 — moderföretagets namn,
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
 * K3 separate "Förändring av eget kapital" statement. Reads opening balances
 * from the K3 balance sheet's equity section (account ranges per BAS):
 *   - 2081 (aktiekapital) → opening aktiekapital
 *   - 2085-2089 (övriga bundna reserver) → bundna_reserver
 *   - 2090-2099 (balanserade vinstmedel + årets resultat) → fritt eget kapital
 *
 * Year movements (nyemission, utdelning) aren't trivially derivable from
 * closing balances alone — they require movement analysis. v1 reports the
 * year's net result and leaves nyemission/utdelning at 0; future iterations
 * can extract these from journal entries on specific accounts.
 */
function buildK3EquityChangesStatement(
  sections: BalanceSheetSection[],
  netResult: number,
): { rows: EgenKapitalRow[]; closing_total: number } {
  // Closing balance from BS — we approximate opening = closing - net result,
  // which is exact when no equity movements happened outside årets resultat.
  // For nyemission/utdelning the user can edit the equity-change narrative
  // in a future enhancement.
  let aktiekapitalClosing = 0
  let bundnaClosing = 0
  let fritProtClosing = 0
  for (const section of sections) {
    for (const row of section.rows) {
      const num = row.account_number
      // BAS 2081-2084 = aktiekapital + medlemsinsatser
      // BAS 2085-2087 = bundna reserver (uppskrivningsfond, reservfond, bundna fonder)
      // BAS 2090-2099 = fritt eget kapital (including årets resultat 2099)
      if (num >= '2081' && num <= '2084') {
        aktiekapitalClosing += row.amount
      } else if (num >= '2085' && num <= '2087') {
        bundnaClosing += row.amount
      } else if (num.startsWith('209')) {
        fritProtClosing += row.amount
      }
    }
  }
  // Opening fritt eget kapital = closing − net result (årets resultat
  // already lives in 2099 at closing).
  const opening = {
    aktiekapital: Math.round(aktiekapitalClosing * 100) / 100,
    bundna_reserver: Math.round(bundnaClosing * 100) / 100,
    balanserade_vinstmedel:
      Math.round((fritProtClosing - netResult) * 100) / 100,
  }
  const changes = {
    nyemission: 0,
    utdelning: 0,
    arets_resultat: Math.round(netResult * 100) / 100,
  }
  return buildEquityChangesNote({ opening, changes })
}

function flattenIncomeStatement(is: {
  revenue_sections: IncomeStatementSection[]
  total_revenue: number
  expense_sections: IncomeStatementSection[]
  total_expenses: number
  financial_sections: IncomeStatementSection[]
  total_financial: number
  net_result: number
}): IncomeStatementLine[] {
  const lines: IncomeStatementLine[] = []
  for (const s of is.revenue_sections) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
    }
  }
  lines.push({ label: 'Summa rörelseintäkter', amount: is.total_revenue, is_total: true })
  for (const s of is.expense_sections) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: -r.amount })
    }
  }
  lines.push({
    label: 'Rörelseresultat',
    amount: is.total_revenue - is.total_expenses,
    is_total: true,
  })

  // Split financial sections so the RR follows the K2 / ÅRL 3:2 structure:
  // financial items (80–87) → "Resultat efter finansiella poster" →
  // bokslutsdispositioner (88) → "Resultat före skatt" → skatt (89) →
  // "Årets resultat". Without the dispositioner + skatt rows the document
  // is non-compliant for any AB that posted bolagsskatt or
  // periodiseringsfond, and the RR doesn't reconcile to BS 2099.
  const finItems = is.financial_sections.filter(
    (s) => !/bokslutsdisposition|skatter och årets resultat/i.test(s.title),
  )
  const dispositionsSections = is.financial_sections.filter((s) =>
    /bokslutsdisposition/i.test(s.title),
  )
  const skattSections = is.financial_sections.filter((s) =>
    /skatter och årets resultat/i.test(s.title),
  )
  for (const s of finItems) {
    for (const r of s.rows) {
      lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
    }
  }
  const finSubtotal = finItems.reduce((sum, s) => sum + s.subtotal, 0)
  const resAfterFinancial = is.total_revenue - is.total_expenses + finSubtotal
  lines.push({
    label: 'Resultat efter finansiella poster',
    amount: Math.round(resAfterFinancial * 100) / 100,
    is_total: true,
  })

  if (dispositionsSections.length > 0) {
    for (const s of dispositionsSections) {
      for (const r of s.rows) {
        lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
      }
    }
    const dispositionsSubtotal = dispositionsSections.reduce((sum, s) => sum + s.subtotal, 0)
    lines.push({
      label: 'Resultat före skatt',
      amount: Math.round((resAfterFinancial + dispositionsSubtotal) * 100) / 100,
      is_total: true,
    })
  } else {
    // No dispositioner posted — keep the simpler "Resultat före skatt" row
    // immediately after the finansnetto totals so the RR still has the
    // pre-tax subtotal expected by ÅRL.
    lines.push({
      label: 'Resultat före skatt',
      amount: Math.round(resAfterFinancial * 100) / 100,
      is_total: true,
    })
  }

  if (skattSections.length > 0) {
    for (const s of skattSections) {
      for (const r of s.rows) {
        lines.push({ label: `${r.account_number} ${r.account_name}`, amount: r.amount })
      }
    }
  }

  lines.push({ label: 'Årets resultat', amount: is.net_result, is_total: true })
  return lines
}

function flattenBalanceSheet(bs: {
  asset_sections: BalanceSheetSection[]
  total_assets: number
  equity_liability_sections: BalanceSheetSection[]
  total_equity_liabilities: number
}): {
  assets: BalanceSheetLine[]
  total_assets: number
  equity_liabilities: BalanceSheetLine[]
  total_equity_liabilities: number
} {
  const assetLines: BalanceSheetLine[] = []
  for (const s of bs.asset_sections) {
    assetLines.push({ label: s.title, amount: s.subtotal, is_total: true, indent: 0 })
    for (const r of s.rows) {
      assetLines.push({
        label: `${r.account_number} ${r.account_name}`,
        amount: r.amount,
        indent: 1,
      })
    }
  }
  const eqLines: BalanceSheetLine[] = []
  for (const s of bs.equity_liability_sections) {
    eqLines.push({ label: s.title, amount: s.subtotal, is_total: true, indent: 0 })
    for (const r of s.rows) {
      eqLines.push({
        label: `${r.account_number} ${r.account_name}`,
        amount: r.amount,
        indent: 1,
      })
    }
  }
  return {
    assets: assetLines,
    total_assets: bs.total_assets,
    equity_liabilities: eqLines,
    total_equity_liabilities: bs.total_equity_liabilities,
  }
}
