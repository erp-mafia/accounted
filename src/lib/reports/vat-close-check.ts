/**
 * The momsdeklaration as agents and API clients read it, and the "can I close
 * VAT?" answer, computed once for every door: the MCP tools
 * gnubok_get_vat_report, gnubok_vat_review_widget and gnubok_vat_close_check,
 * and the v1 compliance check (type=vat_close).
 *
 * The rutor ARE the declaration the web momsdeklaration, its exports and the
 * Skatteverket submission file (computeVatDeclaration in ./vat-declaration.ts),
 * signed as filed; the completeness checks are ./vat-declaration-checks.ts
 * through the filing gate the web UI's Skicka button reads
 * (./vat-filing-gate.ts), and vatFilingVerdict below is that gate on the
 * server, which every path that sends a declaration to Skatteverket runs
 * first. Moved here from the MCP server, where the v1 door could not reach it
 * (core never imports an extension).
 */
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import type { SupabaseClient } from '@supabase/supabase-js'
import { type EntryLinesQuery, fetchLinesByEntryIds } from '@/lib/bookkeeping/entry-lines'
import { fiscalYearLockedToCalendar, isEntityType } from '@/lib/company/entity-type'
import { nextDay } from '@/lib/core/bookkeeping/kontantmetod-cutoff'
import { codedRefusal } from '@/lib/errors/refusal'
import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { DEFAULT_SETTLEMENT_ACCOUNT, resolveCashAccountScope } from '@/lib/reconciliation/cash-account-scope'
import { findRcBasisGaps, type RcBasisGap } from '@/lib/reports/rc-basis-gaps'
import { computeVatDeclaration, type MomsredovisningDetection, rcInputTotalsFromDeclaration, VAT_SETTLEMENT_NET_ACCOUNTS, type VatPeriodSource, type VatSettlementShapedEntry } from '@/lib/reports/vat-declaration'
import { revenueAccountWithoutRutaFinding, vatAccountWithoutRutaFinding, runVatDeclarationChecks, selfAssessedVatWithoutAnyInputVat, type VatCheckReviewMark, type VatDeclarationCheck, type VatDeclarationCheckStatus } from '@/lib/reports/vat-declaration-checks'
import { listVatCheckReviews } from '@/lib/vat/check-review-store'
import { fetchKontantmetodCutoffVatFacts } from '@/lib/vat/kontantmetod-cutoff-vat-facts'
import { applyVatCheckReviews, isReviewableVatCheck, type VatCheckReview, type VatCheckReviewInputs } from '@/lib/vat/check-reviews'
import { isFilingBlocked, type RcBasisGapScan, withRcBasisGapFindings } from '@/lib/reports/vat-filing-gate'
import { buildFiledAmounts } from '@/lib/reports/vat-manual-filing'
import { findUnattributedEuSales, type PsWarning } from '@/lib/reports/periodisk-sammanstallning'
import { euTradeInRutor, formatEuTradeBoxes, helarsmomsHasEuTrade } from '@/lib/reports/eu-trade'
import { roundOre } from '@/lib/money'
import { formatCurrency } from '@/lib/utils'
import { computeSettlementAccountDrift, type SettlementAccountDrift } from '@/lib/reports/vat-settlement-account-drift'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getVatDeadlineForPeriod, type VatDeadlineCalculationSettings } from '@/lib/tax/deadline-config'
import { adjustDeadlineToNextBankingDay } from '@/lib/tax/swedish-holidays'
import { countUnbookedBankTransactions } from '@/lib/transactions/unbooked'
import type { KontantmetodCutoffVatFacts, VatDeclaration, VatDeclarationRutor } from '@/types'
import { createLogger } from '@/lib/logger'
import { parseVatPeriodArgs } from './vat-period-args'
import { compareVatPeriods, type VatCloseSanity, type VatSanityRutor } from './vat-period-comparison'

const log = createLogger('reports/vat-close-check')

/** Plain two-decimal amounts for agent-facing English prose ("1234.50"). */
export const AGENT_AMOUNT_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  useGrouping: false,
})

// ── VAT report computation (shared by gnubok_get_vat_report + gnubok_vat_review_widget) ──
//
// The report is the momsdeklaration itself: computeVatDeclaration, the one
// projection of the ledger onto the SKV 4700 rutor (ACCOUNT_RUTA plus the
// company's own classified accounts), signed exactly as rutorToMomsuppgift
// files it. ruta49 covers domestic output VAT (10/11/12), reverse-charge
// output VAT (30/31/32) and import VAT (60/61/62) less ruta48, per
// ML 2023:200. A class 3 account the declaration puts in no ruta is named in
// the warnings instead of being widened into ruta 05 here: a ruta 05 the
// filing does not carry is a figure the agent cannot check against
// Skatteverket (the compatibility list that did that was removed 2026-10-13).
//
// Posted+reversed status filter: a "reversed" original entry is still part of
// its period's books: Skatteverket files VAT period-by-period under
// faktureringsmetoden (sale's VAT in invoice-date period; kreditfaktura's
// reduction in storno-date period). The original entry stays in its period;
// the storno (status 'posted', dated when the credit was issued) lands in
// its own period. The two periods file independently; across a year they
// arithmetically cancel. *Excluding* 'reversed' would under-report Period N
// (the original sale's VAT silently disappears) and over-credit Period N+M
// (a reversal with no original), incorrect per ML 2023:200.

interface VatReportResult {
  period: { type: string; year: number; period: number; start: string; end: string }
  period_label: string
  /**
   * Every box of the SKV 4700 declaration, keyed exactly like
   * VatDeclarationRutor, so no box the Skatteverket filing carries can be
   * missing from what the agent reads (agent feedback seq 911266: ruta 50 was
   * filed but never shown). Signed as filed: a box whose credit notes
   * exceed its sales is negative here as it is in the filing.
   */
  rutor: VatDeclarationRutor
  /**
   * Moms att betala (positive) or få tillbaka (negative) as it is filed, booked
   * and paid: buildFiledAmounts(rutor).net, every ruta in whole kronor.
   * rutor.ruta49 is the same sum before the öre are dropped; a surface that
   * states the amount reads this one. Not declared in VAT_REPORT_OUTPUT_SCHEMA,
   * like excluded_settlement_entries below: the schema leaves the top level
   * open and the tools/list payload has a frozen ceiling.
   */
  net_filed: number
  summary: string
  warnings: string[]
  /**
   * The verifikat in the period that are NOT in the rutor because they are
   * classified as momsredovisning. Without this an agent comparing a ruta with
   * the general ledger sees a gap and nothing that explains it (#2805).
   * Capped at EXCLUDED_SETTLEMENT_ENTRIES_CAP; `count` is the uncapped total.
   * Not declared in VAT_REPORT_OUTPUT_SCHEMA on purpose: that schema leaves the
   * top level open, and the tools/list payload budget has no room for prose.
   */
  excluded_settlement_entries: {
    count: number
    truncated: boolean
    note: string
    entries: VatExcludedSettlementEntry[]
  }
}

/** One verifikat kept out of the rutor as a momsredovisning. */
interface VatExcludedSettlementEntry {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  source_type: string | null
  /**
   * `tagged`: source_type vat_settlement. `net_account_shape`: a declaration
   * account and a 2650/1650 line. `tax_account_shape`: only 26xx, the
   * skattekonto 1630 and 3740. The shapes are decided in SQL
   * (get_vat_declaration_totals); see listExcludedSettlementEntries.
   */
  detected_by: MomsredovisningDetection
}

const EXCLUDED_SETTLEMENT_ENTRIES_CAP = 20

const EXCLUDED_SETTLEMENT_ENTRIES_NOTE =
  'Dessa verifikat är klassade som momsredovisning (taggade vat_settlement, eller igenkända på formen: ' +
  'ett momskonto mot 2650/1650, eller enbart 26xx mot skattekontot 1630) och ingår därför inte i rutorna. ' +
  'Skiljer sig en ruta från huvudboken är det här förklaringen finns.'

/**
 * Name the verifikat get_vat_declaration_totals kept out of the rutor as a
 * momsredovisning, so an agent comparing a ruta with the general ledger sees
 * what explains the gap (#2805). The RPC decides; this only labels:
 *
 *   - the shape-detected entries are the RPC's own settlement_shaped_entries.
 *     Its two shapes are disjoint on a 2650/1650 line (the net-account shape
 *     requires one, the skattekonto shape forbids one), so that line alone
 *     tells which shape matched, with no second copy of the predicate;
 *   - the tagged entries (source_type vat_settlement) are filtered inside the
 *     RPC without being listed, so they are read here by their tag.
 *
 * Sorted by date, then voucher label in numeric order.
 */
async function listExcludedSettlementEntries(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string,
  shapedEntries: VatSettlementShapedEntry[],
): Promise<VatExcludedSettlementEntry[]> {
  const [tagged, netLines] = await Promise.all([
    fetchAllRows<{
      id: string
      entry_date: string
      source_type: string | null
      voucher_series: string | null
      voucher_number: number | null
    }>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, entry_date, source_type, voucher_series, voucher_number')
        .eq('company_id', companyId)
        .eq('source_type', 'vat_settlement')
        .in('status', ['posted', 'reversed'])
        .gte('entry_date', start)
        .lte('entry_date', end)
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchLinesByEntryIds<{ id: string; journal_entry_id: string }>(
      supabase,
      shapedEntries.map((e) => e.id),
      'id, journal_entry_id',
      (q: EntryLinesQuery) => q.in('account_number', VAT_SETTLEMENT_NET_ACCOUNTS),
    ),
  ])
  const hasNetAccountLine = new Set(netLines.map((l) => l.journal_entry_id))

  const entries: VatExcludedSettlementEntry[] = [
    ...tagged.map((e) => ({
      journal_entry_id: e.id,
      voucher_label: formatVoucher(e, { separator: '-' }),
      entry_date: e.entry_date ?? '',
      source_type: e.source_type,
      detected_by: 'tagged' as const,
    })),
    ...shapedEntries.map((e) => ({
      journal_entry_id: e.id,
      voucher_label: formatVoucher(e, { separator: '-' }),
      entry_date: e.entry_date ?? '',
      source_type: e.source_type,
      detected_by: hasNetAccountLine.has(e.id)
        ? ('net_account_shape' as const)
        : ('tax_account_shape' as const),
    })),
  ]
  return entries.sort((a, b) =>
    a.entry_date === b.entry_date
      ? a.voucher_label.localeCompare(b.voucher_label, 'sv', { numeric: true })
      : a.entry_date < b.entry_date ? -1 : 1,
  )
}

interface VatReportWithRutor {
  report: VatReportResult
  /**
   * The declaration the report shows, as computeVatDeclaration returned it:
   * the completeness verdict runs on this object (vatFilingVerdict), so the
   * close check judges exactly what would be filed.
   */
  declaration: VatDeclaration
  /**
   * Which branch of resolvePeriodDates produced `report.period`. Kept off the
   * report itself: gnubok_get_vat_report declares its period object closed
   * (additionalProperties: false), so the close check is the surface that
   * discloses a yearly calendar fallback.
   */
  periodSource: VatPeriodSource
  /**
   * EVERY verifikat kept out of the rutor as a momsredovisning, uncapped
   * (`report.excluded_settlement_entries.entries` is the capped wire view).
   * The close check names the shape-detected ones from this list.
   */
  excludedSettlementEntries: VatExcludedSettlementEntry[]
}

/**
 * Agent-facing VAT report. Thin wrapper over {@link computeVatReportWithRutor}
 * so callers that only need the report keep the old signature.
 */
export async function computeVatReport(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatReportResult> {
  const { report } = await computeVatReportWithRutor(args, companyId, supabase)
  return report
}

async function computeVatReportWithRutor(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatReportWithRutor> {
  const { periodType, year, period } = parseVatPeriodArgs(args)

  // The declaration the web momsdeklaration, its exports and the Skatteverket
  // submission file, computed by the same function: get_vat_declaration_totals
  // through fetchVatAccountTotals, minus the bokslutsverifikat, the marked
  // kontantmetod vändningar and every momsredovisning (crm#1139, #2805). This
  // report used to project that aggregate a second time, with its own ruta 05
  // account list and absolute values, and so showed figures nobody files.
  const { declaration, periodSource, settlementShapedEntries } = await computeVatDeclaration(
    supabase,
    companyId,
    periodType,
    year,
    period,
  )
  const { start: startDate, end: endDate } = declaration.period
  const excludedEntries = await listExcludedSettlementEntries(
    supabase,
    companyId,
    startDate,
    endDate,
    settlementShapedEntries,
  )

  const rutor: VatDeclarationRutor = { ...declaration.rutor }
  const { ruta30, ruta31, ruta32 } = rutor
  const filedNet = buildFiledAmounts(rutor).net
  // Import VAT (since 2015 declared via momsdeklaration, not Tullverket): the
  // importer books output VAT to 2615/2625/2635 (ruta 60/61/62) and the
  // matching deductible input to 2645 (rolls into ruta 48).
  const debitBalance = (account: string): number => {
    const t = declaration.rcInputAccountTotals?.[account]
    return t ? roundOre(t.debit - t.credit) : 0
  }
  const calculatedInput2645 = debitBalance(resolveAccountRole(PINNED_JURISDICTION, 'input_vat_reverse_charge_foreign'))
  const calculatedInput2647 = debitBalance(resolveAccountRole(PINNED_JURISDICTION, 'input_vat_reverse_charge_domestic'))

  const monthNames = ['Januari', 'Februari', 'Mars', 'April', 'Maj', 'Juni',
    'Juli', 'Augusti', 'September', 'Oktober', 'November', 'December']

  let periodLabel: string
  if (periodType === 'monthly') periodLabel = `${monthNames[period - 1]} ${year}`
  else if (periodType === 'quarterly') periodLabel = `Q${period} ${year}`
  else periodLabel = `${year}`

  // Pre-filing warnings: surface common compliance footguns.
  //
  // The matching input for reverse-charge output (2614/2624/2634) lands on
  // 2645 (EU acquisitions) or 2647 (domestic reverse charge per ML 16:13,
  // byggtjänster, electronics > 100k SEK, etc.). Either is a valid mirror;
  // the warning must fire only when *both* are zero.
  const warnings: string[] = []
  const totalReverseChargeOutput = ruta30 + ruta31 + ruta32
  const totalReverseChargeInput = calculatedInput2645 + calculatedInput2647
  if (totalReverseChargeOutput > 0 && totalReverseChargeInput === 0) {
    warnings.push(
      'Omvänd betalningsskyldighet: utgående moms har bokförts (rutor 30/31/32) men ingen ' +
      'beräknad ingående moms (varken 2645 EU eller 2647 inhemsk). Kontrollera att den ' +
      'motsvarande ingående bokningen finns: båda sidor krävs enligt ML 2023:200.'
    )
  }
  // Class 3 balances the declaration puts in no ruta (#3387): the same
  // finding, in the same words, the completeness checks give.
  const revenueWithoutRuta = declaration.revenueAccountsWithoutRuta ?? []
  if (revenueWithoutRuta.length > 0) {
    warnings.push(revenueAccountWithoutRutaFinding(revenueWithoutRuta).message)
  }
  // Moms accounts no ruta reads: the same finding, in the same words.
  const vatWithoutRuta = declaration.vatAccountsWithoutRuta ?? []
  if (vatWithoutRuta.length > 0) {
    warnings.push(vatAccountWithoutRutaFinding(vatWithoutRuta).message)
  }

  const report: VatReportResult = {
    period: { type: periodType, year, period, start: startDate, end: endDate },
    period_label: periodLabel,
    rutor,
    // The net as filed (whole kronor per ruta), not the öre sum in ruta49:
    // the same figure the momsverifikat books (crm#1171).
    net_filed: filedNet,
    summary: filedNet > 0
      ? `Moms att betala: ${filedNet} kr`
      : filedNet < 0
        ? `Moms att få tillbaka: ${Math.abs(filedNet)} kr`
        : 'Noll i moms',
    warnings,
    excluded_settlement_entries: {
      count: excludedEntries.length,
      truncated: excludedEntries.length > EXCLUDED_SETTLEMENT_ENTRIES_CAP,
      note: EXCLUDED_SETTLEMENT_ENTRIES_NOTE,
      entries: excludedEntries.slice(0, EXCLUDED_SETTLEMENT_ENTRIES_CAP),
    },
  }

  return {
    report,
    declaration,
    periodSource,
    excludedSettlementEntries: excludedEntries,
  }
}

/**
 * The momsdeklaration completeness verdict, on the server: the "Kontroll av
 * underlaget" gate the web filing UI computes in the browser
 * (VatDeclarationView: runVatDeclarationChecks over the declaration, folded
 * through withRcBasisGapFindings with the per-verifikat scan, then
 * isFilingBlocked), composed the same way over the same declaration.
 *
 * Every path that sends a declaration to Skatteverket runs this before its
 * first call there and refuses when `blocked` (the dashboard draft and
 * one-click submit routes, the submit chain an approved MCP operation
 * commits through, MCP staging), because the browser check alone is no gate
 * for a caller that never loads the page. gnubok_vat_close_check and
 * gnubok_vat_declaration_validate report the same verdict. The manual
 * eSKD/PDF filing stays ungated on purpose (vat-filing-gate.ts). Lives here,
 * not in vat-filing-gate.ts, because that module is imported by the client.
 *
 * The per-verifikat scan is allowed to degrade: a failure becomes
 * `{ status: 'unavailable' }`, which the gate turns into an explicit WARNING
 * finding rather than silence, because an empty list reads as "no problems"
 * and that claim is not earned when the scan never answered.
 *
 * `fiscalPeriodId` scans the räkenskapsår the declaration was computed for
 * (helårsmoms on a broken fiscal year); pass what the declaration got.
 *
 * `kontantmetodCutoff` (fetchKontantmetodCutoffVatFacts) feeds the
 * kontantmetoden year-end cut-off WARNINGs (#3440) the web view shows. The
 * readers that report findings to someone pass it (vatFilingVerdictWithReviews,
 * the review service); the filing paths do not pay for the read, since a
 * WARNING never changes `blocked`.
 */
export interface VatFilingVerdict {
  checks: VatDeclarationCheck[]
  /** isFilingBlocked(checks): an ERROR finding, the state the UI disables Skicka on. */
  blocked: boolean
  /**
   * The per-verifikat scan the checks were folded with, null when it could
   * not run. A review fingerprint (src/lib/vat/check-reviews.ts) reads it.
   */
  gaps: RcBasisGap[] | null
}

export async function vatFilingVerdict(
  supabase: SupabaseClient,
  companyId: string,
  declaration: VatDeclaration,
  options: { fiscalPeriodId?: string; kontantmetodCutoff?: KontantmetodCutoffVatFacts } = {},
): Promise<VatFilingVerdict> {
  const { type: periodType, year, period } = declaration.period
  let scan: RcBasisGapScan
  let gaps: RcBasisGap[] | null = null
  try {
    gaps = await findRcBasisGaps(supabase, companyId, periodType, year, period, {
      fiscalPeriodId: options.fiscalPeriodId,
    })
    scan = { status: 'scanned', gapCount: gaps.length }
  } catch {
    scan = { status: 'unavailable' }
  }
  const checks = withRcBasisGapFindings(
    runVatDeclarationChecks(declaration.rutor, rcInputTotalsFromDeclaration(declaration), {
      revenueAccountsWithoutRuta: declaration.revenueAccountsWithoutRuta,
      vatAccountsWithoutRuta: declaration.vatAccountsWithoutRuta,
      kontantmetodCutoff: options.kontantmetodCutoff ?? declaration.kontantmetodCutoff,
    }),
    scan,
    declaration.rcBasisByRate
      ? { rutor: declaration.rutor, rcBasisByRate: declaration.rcBasisByRate }
      : undefined,
  )
  return { checks, blocked: isFilingBlocked(checks), gaps }
}

/**
 * vatFilingVerdict with the period's stored reviews applied (crm#1171): a
 * WARNING a person accepted for the period, with its figures unchanged,
 * carries `review`. For the readers that report findings to someone
 * (gnubok_vat_close_check, gnubok_vat_declaration_validate); the filing paths
 * keep calling vatFilingVerdict, and `blocked` is the same either way because
 * a review never attaches to an ERROR. A failed review read leaves the
 * warnings unreviewed: they nag once more, nothing is hidden.
 */
export async function vatFilingVerdictWithReviews(
  supabase: SupabaseClient,
  companyId: string,
  declaration: VatDeclaration,
  options: { fiscalPeriodId?: string } = {},
): Promise<VatFilingVerdict & { inputs: VatCheckReviewInputs }> {
  // The kontantmetoden cut-off WARNINGs the web view shows (#3440). Never
  // throws: a failed read is its own warning.
  const kontantmetodCutoff = await fetchKontantmetodCutoffVatFacts(
    supabase, companyId, declaration.period.start, declaration.period.end,
  )
  const verdict = await vatFilingVerdict(supabase, companyId, declaration, { ...options, kontantmetodCutoff })
  const inputs: VatCheckReviewInputs = { declaration, gaps: verdict.gaps }
  if (!verdict.checks.some((check) => isReviewableVatCheck(check, inputs))) return { ...verdict, inputs }
  let reviews: VatCheckReview[] = []
  try {
    reviews = await listVatCheckReviews(supabase, companyId, declaration.period, { labelClient: supabase })
  } catch (err) {
    log.warn('vat check reviews unavailable, reporting warnings unreviewed', {
      error: err instanceof Error ? err.message : String(err),
    })
  }
  return { ...verdict, checks: applyVatCheckReviews(verdict.checks, reviews, inputs), inputs }
}

/** Wire shape for a completeness finding on the MCP surface. */
export interface VatCompletenessFinding {
  code: VatDeclarationCheck['code']
  status: VatDeclarationCheckStatus
  message: string
  rutor: string[]
  /** Present when the caller passed the review inputs: whether gnubok_mark_vat_check_reviewed accepts this finding. */
  reviewable?: boolean
  /** Present with `reviewable`: who accepted the warning for this period, or null. */
  review?: VatCheckReviewMark | null
}

/**
 * Serialize findings for an agent. Unlike the web UI (which deliberately hides
 * the rule ids as visual noise, DECISIONS.md archive 2026-07-24), the machine surface
 * carries `code`: an agent needs a stable key to branch on, not prose. With
 * `inputs` (the readers that apply reviews) each finding also says whether it
 * can be marked reviewed and who did.
 */
export function toCompletenessFindings(
  checks: VatDeclarationCheck[],
  inputs?: VatCheckReviewInputs,
): VatCompletenessFinding[] {
  return checks.map((c) => ({
    code: c.code,
    status: c.status,
    message: c.message,
    rutor: (c.rutor ?? []) as string[],
    ...(inputs ? { reviewable: isReviewableVatCheck(c, inputs), review: c.review ?? null } : {}),
  }))
}

/**
 * The medium finding for moms left on 2650/1650 after Skatteverket charged or
 * paid it: never a stop on the close, because the period being declared is
 * right; the books around it are not. Below 100 kr it is rounding.
 */
export function settlementAccountDriftBlocker(drift: SettlementAccountDrift): VatCloseBlocker | null {
  const MIN_DRIFT_KR = 100
  const parts: string[] = []
  if (drift.payable_drift >= MIN_DRIFT_KR) {
    parts.push(`${formatCurrency(drift.payable_drift, 'SEK')} på 2650 är moms att betala som fördes dit för mer än 150 dagar sedan och som Skatteverkets debitering aldrig har bokförts mot`)
  }
  if (drift.receivable_drift >= MIN_DRIFT_KR) {
    parts.push(`${formatCurrency(drift.receivable_drift, 'SEK')} på 1650 är moms att få tillbaka äldre än 150 dagar som aldrig har bokförts som utbetald`)
  }
  if (parts.length === 0) return null
  return {
    kind: 'earlier_vat_on_settlement_account',
    severity: 'medium',
    count: parts.length,
    message: `${parts.join('; ')}. Tidigare perioders moms ligger alltså kvar, och skulden eller fordran i balansräkningen stämmer inte.`,
    hint:
      'Bokför Skatteverkets momsrader på skattekontot (sidan Skattekonto, eller gnubok_book_skattekonto_rows), eller betalningen till ' +
      'Skatteverket mot 2650. Hör beloppet till en period som redan är betald och bokförd på annat konto, rätta med en verifikation.',
  }
}

// ── VAT close check (composes VAT report + blocker scans + sanity ratios) ──
//
// Intent-shaped tool: answers "can I close VAT for this period?" in one call.
// Replaces the 5-7 chained tool calls (vat_report + uncategorized + supplier
// invoices + reconciliation + voucher gaps + prior-period compare) the agent
// would otherwise need to assemble the same answer.

interface VatCloseBlocker {
  kind:
    | 'uncategorized_transactions'
    | 'unapproved_supplier_invoices'
    | 'bank_unreconciled'
    | 'missing_high_value_receipts'
    | 'reverse_charge_input_missing'
    | 'declaration_incomplete'
    | 'deadline_unavailable'
    | 'fiscal_year_not_found'
    | 'momsredovisning_entries_excluded'
    | 'eu_trade_setting_off'
    | 'unattributed_eu_sale'
    | 'earlier_vat_on_settlement_account'
  severity: 'high' | 'medium' | 'low'
  count: number
  message: string
  hint: string
  /**
   * Only on `momsredovisning_entries_excluded`: the verifikat the finding is
   * about, capped like the report's list. `blockers` items are open objects in
   * the outputSchema, so this costs no tools/list budget.
   */
  entries?: VatExcludedSettlementEntry[]
  /**
   * Only on `unattributed_eu_sale`: one item per sale, the periodisk
   * sammanställning's own finding (verifikat, amount, message), capped at
   * EXCLUDED_SETTLEMENT_ENTRIES_CAP; `count` is the uncapped total.
   */
  eu_sales?: Array<{ journal_entry_id: string | null; amount: number | null; message: string }>
  /**
   * Stable rule id when this blocker comes from the shared momsdeklaration
   * completeness checks (lib/reports/vat-declaration-checks.ts), so an agent
   * can branch on the rule rather than parse the Swedish message.
   */
  check_code?: VatDeclarationCheck['code']
}

/**
 * Hint for the uncategorized_transactions blocker. Must name BOTH resolution
 * paths: categorize/auto-match creates NEW bookkeeping, so for a transaction
 * whose affärshändelse is already booked on an existing verifikat the agent
 * needs gnubok_link_transaction_to_journal_entry instead; a hint that only
 * offers the booking tools dead-ends that case into "contact support"
 * (2026-08-06 support case). Exported so the test can pin the contract.
 */
export const UNCATEGORIZED_TRANSACTIONS_HINT =
  'Kategorisera via gnubok_categorize_transaction eller kör gnubok_auto_match_period. ' +
  'Är affärshändelsen redan bokförd på ett befintligt verifikat: koppla i stället med ' +
  'gnubok_link_transaction_to_journal_entry (ingen ny bokföring skapas).'

/**
 * Hint for a blocking (ERROR) RC_BASIS_MISSING: names the repair, not only the
 * rutor. The finding means verifikat carry fiktiv moms without the basis pair, which
 * gnubok_correct_entry adds (the same storno + corrected entry the web
 * momsvy's Korrigera books). New reverse-charge categorizations carry the
 * pair themselves (#2919), so this is the path for history. Exported so the
 * test can pin the contract.
 */
export const RC_BASIS_MISSING_HINT =
  'Verifikat med fiktiv moms (2614/2624/2634) saknar basbelopp: hitta dem i huvudboken för 2614/2624/2634 ' +
  '(gnubok_get_general_ledger) och lägg till 45xx D / 4598 K via gnubok_correct_entry, per momssats bara det ' +
  'som saknas: fiktiv moms / sats minus det basbelopp verifikatet redan redovisar på den satsen i ruta 20-24, ' +
  'på 44xx/45xx eller på ett konto vars momskod redovisar ruta 20-24. Konton för 25/12/6 %: 4535-4537 ' +
  'EU-tjänster ruta 21, 4531-4533 tjänster utanför EU ruta 22, 4515-4517 EU-varor ruta 20. Eller Korrigera i ' +
  'momsvyn. Har ett konto en momskod för omvänd skattskyldighet utan Standard moms 25, 12 eller 6 %, rätta ' +
  'kontot i kontoplanen först.'

/**
 * Hint for a pair finding whose moms side is booked but under a krona
 * (VatDeclarationCheck.belowOneKrona: FK001, FK003 or FK005 by presence,
 * vat-declaration-checks.ts). The whole-krona rule empties the moms rutor,
 * the ledger is not short, so the default "review the rutor in the ledger"
 * would send an agent to correct verifikat that are right, or to add moms the
 * purchase does not carry. Names no amounts to file instead: that is a tax
 * judgment the product has not made (crm#1822). Exported so the test can pin
 * the contract.
 */
export const VAT_BELOW_ONE_KRONA_HINT =
  'Rätta ingenting i bokföringen för det här: momsen är bokförd men under en krona och faller bort när ' +
  'deklarationen lämnas i hela kronor. Lägg inte till, ändra eller storno verifikat för att få kontrollen ' +
  'att passera. Perioden kan inte lämnas till Skatteverket från Accounted med de här beloppen: säg det till ' +
  'användaren och hänvisa till Skatteverket för hur perioden ska redovisas.'

/**
 * Hint for the blocking RC_BASIS_MISSING when the period's fiktiv moms is
 * NEGATIVE (rutor 30-32 below zero, rutor 20-24 empty: FK004 by presence,
 * vat-declaration-checks.ts). The basis is missing on the other side: a credit
 * of a reverse-charge purchase (2614/2624/2634 debited) whose basis did not
 * follow. Adding 45xx D / 4598 K would push rutor 20-24 the wrong way, and
 * Korrigera in the momsvy lists only positive gaps, so the hint names the
 * opposite pair and the storno path. Exported so the test can pin the contract.
 */
export const RC_BASIS_NEGATIVE_HINT =
  'Den fiktiva momsen (2614/2624/2634) är negativ i perioden men ruta 20-24 är tomma: lägg INTE till ' +
  '45xx D / 4598 K, det ökar underlaget åt fel håll. Hitta verifikaten som debiterar 2614/2624/2634 i ' +
  'huvudboken (gnubok_get_general_ledger). Är det en kreditnota på ett inköp med omvänd ' +
  'skattskyldighet: rätta verifikatet med gnubok_correct_entry så att underlaget följer med åt samma håll, ' +
  '4598 D / 45xx K på samma basbeloppskonto som inköpet (4535-4537 EU-tjänster ruta 21, 4531-4533 ' +
  'tjänster utanför EU ruta 22, 4515-4517 EU-varor ruta 20). Har en rättelse flyttat bara den fiktiva ' +
  'momsen: återför den med storno och rätta underlag och fiktiv moms i samma verifikation, i den period ' +
  'där inköpet redovisades.'

/**
 * Hint for the advisory (WARNING) RC_BASIS_MISSING: the period's basis matches
 * its fiktiv moms per momssats, so the flagged verifikat's basis is booked in
 * another verifikat. Adding basis would count it twice; what is left is the
 * user's check that the other verifikat covers these purchases, recorded as a
 * review (crm#1171). Exported so the test can pin the contract.
 */
export const RC_BASIS_ADVISORY_HINT =
  'Lägg inte till basbelopp: summan per momssats stämmer, så basbeloppet för dessa verifikat finns i ett annat ' +
  'verifikat i perioden (ofta ett rättelseverifikat). Visa användaren verifikaten (gnubok_get_general_ledger för ' +
  '2614/2624/2634 och 44xx/45xx). Bekräftar användaren att basbeloppet avser just de här inköpen: ' +
  'gnubok_mark_vat_check_reviewed med check_code RC_BASIS_MISSING och en notering om var basbeloppet finns.'

/**
 * Appended to the hint of every other reviewable WARNING: once the user has
 * checked it and it is right as booked, the review stops it from coming back
 * until the figures change.
 */
export const VAT_CHECK_REVIEW_HINT =
  'Är det rätt som bokfört enligt användaren: gnubok_mark_vat_check_reviewed med check_code, så återkommer varningen ' +
  'bara om underlaget ändras.'

/**
 * Hint for the bank_unreconciled blocker when every bank row in the period is
 * matched and the whole difference is verifikat with no bank row (crm#185: an
 * SIE import booked January to May, the bank connection returned rows from
 * June). Stäm av counts those verifikat as explained, so a signed avstämning
 * leaves this gate closed: only bank rows for those dates clear it. Linking
 * books nothing, and categorizing would book the same affärshändelse twice,
 * which gnubok_create_transactions' own next step points at. Exported so the
 * test can pin the contract.
 */
export const BANK_ROWS_MISSING_HINT =
  'Importera kontoutdraget för de datumen som bankfil (Importera, Bankfil) eller skapa raderna med ' +
  'gnubok_create_transactions. Koppla dem sedan till de befintliga verifikaten i Stäm av eller med ' +
  'gnubok_reconcile_match: ingenting bokförs på nytt, så kategorisera dem inte. En PDF i Underlag ' +
  'eller en signerad avstämning ersätter inte bankraderna.'

/**
 * Hint for bank_unreconciled when nothing is left to match and the period's
 * whole difference is verifikat settled against a rättelse dated outside the
 * period (crm#1074). There is no bank row to import and nothing to link, so
 * neither of the other hints applies. Reconciliation facts only: whether the
 * check is accepted with the difference is the user's decision. Exported so
 * the test can pin the contract.
 */
export const SETTLED_ELSEWHERE_HINT =
  'Inget att matcha och ingen bankrad att importera: verifikaten är rättade med verifikat daterade i en annan period ' +
  '(gnubok_list_reconciliation_items med bucket "matched" visar vilka). Visa användaren verifikaten och differensen; ' +
  'om kontrollen godtas trots differensen är användarens beslut.'

/**
 * Hint for the REVENUE_ACCOUNT_WITHOUT_RUTA finding (#3387): the fix is on the
 * account, not in the ledger, and it is the user's call which ruta the sales
 * belong in. Exported so the test can pin the contract.
 */
export const REVENUE_ACCOUNT_WITHOUT_RUTA_HINT =
  'Fråga användaren vad kontot avser och sätt sedan default_vat_treatment på kontot med ' +
  'gnubok_update_account (standard_25/reduced_12/reduced_6 för ruta 05, exempt för ruta 42). ' +
  'Avser kontot inte försäljning, sätt default_vat_rate 0. Inga verifikat ändras.'

/**
 * Hint for the VAT_ACCOUNT_WITHOUT_RUTA finding: the fix is the momsruta on
 * the account, and which ruta is the user's call. Moms declared elsewhere
 * (OSS) belongs on no ruta, and then the review is the way out, so the hint
 * names it itself. Exported so the test can pin the contract.
 */
export const VAT_ACCOUNT_WITHOUT_RUTA_HINT =
  'Fråga användaren vad momsen på kontot avser och sätt sedan vat_box på kontot med ' +
  'gnubok_update_account (till exempel 30/31/32 för utgående moms vid omvänd betalningsskyldighet ' +
  '25/12/6 %, 48 för ingående moms). Redovisas momsen inte i momsdeklarationen (till exempel OSS), ' +
  'markera varningen som granskad med gnubok_mark_vat_check_reviewed när användaren bekräftat det. ' +
  'Inga verifikat ändras.'

/**
 * Hint for the unattributed_eu_sale blocker (crm#1362): the sale is already
 * booked, so the fix names a buyer for it without booking it again, or files
 * the buyer in Skatteverket's e-tjänst. Exported so the test can pin the
 * contract.
 */
export const UNATTRIBUTED_EU_SALE_HINT =
  'Bokför inget på nytt. Finns en kundfaktura till köparen (kund med land och VAT-nummer), koppla den till ' +
  'verifikatet: under kontantmetoden med gnubok_link_invoice_to_voucher, under faktureringsmetoden en redan bokförd ' +
  'faktura med gnubok_register_booked_invoice. Annars lägg till köparen i periodisk sammanställning i Skatteverkets ' +
  'e-tjänst. Verifikaten står i eu_sales; per köpare: gnubok_get_periodisk_sammanstallning.'

/**
 * Hint for KONTANTMETOD_CUTOFF_INCOMPLETE in the close check (#88): what
 * kontantmetoden requires at the year end is booking the invoices still
 * unpaid at balansdagen, through the cut-off; never an attest, never by hand.
 * Exported so the test can pin the contract.
 */
export const KONTANTMETOD_CUTOFF_HINT =
  'Under kontantmetoden bokförs kund- och leverantörsfakturor som är obetalda vid räkenskapsårets slut ' +
  '(BFL 5 kap 2 §). gnubok_year_end_readiness visar dem under kontantmetod_cutoff_required; bokför ' +
  'avgränsningen med gnubok_post_kontantmetod_cutoff före inlämning. Bokför aldrig momsen, fordringarna ' +
  'eller skulderna för hand.'

/**
 * The periodisk sammanställning's UNATTRIBUTED_EU_SALE findings as close-check
 * blockers, one per severity, with the PS's own rule: an EU goods or
 * trepartshandel sale (ruta 35/38) without a buyer blocks, as it blocks the
 * PS file; a service (ruta 39) warns. `null` is a read that failed: said, not
 * silenced, since an empty list would read as "every EU sale has a buyer".
 */
function unattributedEuSaleBlockers(sales: PsWarning[] | null): VatCloseBlocker[] {
  if (sales === null) {
    return [{
      kind: 'unattributed_eu_sale',
      severity: 'medium',
      count: 0,
      message:
        'Periodisk sammanställning kunde inte stämmas av mot rutorna 35, 38 och 39: det går inte att säga om ' +
        'varje EU-försäljning i perioden har en köpare med VAT-nummer.',
      hint: 'Kör gnubok_get_periodisk_sammanstallning för perioden före inlämning.',
    }]
  }
  const blockers: VatCloseBlocker[] = []
  for (const level of ['error', 'warning'] as const) {
    const group = sales.filter((sale) => sale.level === level)
    if (group.length === 0) continue
    const total = roundOre(group.reduce((sum, sale) => sum + (sale.amount ?? 0), 0))
    const what = `${group.length} verifikat bokför EU-försäljning ${level === 'error' ? 'av varor eller trepartshandel (ruta 35/38)' : 'av tjänster (ruta 39)'} ` +
      `på sammanlagt ${formatCurrency(total)} utan någon kundfaktura som anger köparens VAT-nummer`
    blockers.push({
      kind: 'unattributed_eu_sale',
      severity: level === 'error' ? 'high' : 'medium',
      count: group.length,
      // One sale: the PS's own words. Several: what they add up to, each one
      // in eu_sales.
      message: group.length === 1
        ? group[0].message
        : level === 'error'
          ? `${what}. En EU-varuförsäljning ska alltid redovisas per köpare, så periodisk sammanställning kan inte lämnas förrän köparna finns med.`
          : `${what}, så periodisk sammanställning kan vara ofullständig. Om köparen har ett VAT-nummer och tjänsten beskattas i köparens land ska köparen redovisas.`,
      hint: UNATTRIBUTED_EU_SALE_HINT,
      eu_sales: group.slice(0, EXCLUDED_SETTLEMENT_ENTRIES_CAP).map((sale) => ({
        journal_entry_id: sale.journalEntryId ?? null,
        amount: sale.amount ?? null,
        message: sale.message,
      })),
    })
  }
  return blockers
}

/**
 * Completeness codes that describe the omvänd-skattskyldighet pair. They keep
 * the pre-existing `reverse_charge_input_missing` blocker kind so clients
 * already switching on it do not lose the case they were watching for.
 */
const RC_COMPLETENESS_CODES = new Set<VatDeclarationCheck['code']>([
  'RC_BASIS_MISSING',
  'RC_OUTPUT_MISSING',
  'RC_INPUT_VAT_MISMATCH',
])

interface VatCloseCheckResult {
  /**
   * `source` discloses whether the range is a resolved räkenskapsår or the
   * calendar arithmetic (yearly: 'calendar_fallback' when no fiscal year ends
   * in `year`). The outputSchema keeps `period` an open object, so this costs
   * no tools/list budget.
   */
  period: VatReportResult['period'] & { source: VatPeriodSource }
  period_label: string
  rutor: VatReportResult['rutor']
  payment: {
    net_due: number
    direction: 'pay' | 'refund' | 'zero'
    deadline: string | null
    deadline_label: string | null
    moms_period: 'monthly' | 'quarterly' | 'yearly' | null
  }
  blockers: VatCloseBlocker[]
  /**
   * The momsdeklaration completeness findings behind the
   * declaration_incomplete / reverse_charge_input_missing blockers, verbatim
   * from the shared checks. Empty means the declaration itself looks complete;
   * it says nothing about the other blockers.
   */
  declaration_checks: VatCompletenessFinding[]
  /** The comparison with the previous period (./vat-period-comparison.ts). Advisory. */
  sanity: VatCloseSanity
  ready_to_close: boolean
  summary: string
}

/** Adapt the canonical VAT deadline configuration to the MCP wire shape. */
export function computeMomsDeadline(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number,
  settings: VatDeadlineCalculationSettings,
): { date: string; label: string } | null {
  const instance = getVatDeadlineForPeriod(periodType, year, period, settings)
  if (!instance) return null

  const adjusted = adjustDeadlineToNextBankingDay(
    new Date(instance.year, instance.month, instance.day),
  )
  const deadlineYear = adjusted.getFullYear()
  const deadlineMonth = adjusted.getMonth() + 1
  const deadlineDay = adjusted.getDate()

  return {
    date: `${deadlineYear}-${String(deadlineMonth).padStart(2, '0')}-${String(deadlineDay).padStart(2, '0')}`,
    label: `${deadlineDay} ${monthName(deadlineMonth)} ${deadlineYear}`,
  }
}

function monthName(m: number): string {
  return ['januari', 'februari', 'mars', 'april', 'maj', 'juni',
    'juli', 'augusti', 'september', 'oktober', 'november', 'december'][m - 1] ?? ''
}

/**
 * Gross floor for the missing-underlag blocker. ML 17 kap 26-28 § (förenklad
 * faktura) expresses 4 000 kr inclusive of moms, so the comparison is against
 * the RPC's gross_amount: the debit total less self-assessed reverse-charge
 * and import moms, which no seller charges, so a reverse-charge purchase is
 * measured by its invoice amount (migration 20261011125000).
 */
const MISSING_UNDERLAG_MIN_GROSS_SEK = 4000

/** One `verifikat_without_documents` page-of-one, used only for its total. */
async function totalMissingUnderlagSince(
  supabase: SupabaseClient,
  companyId: string,
  since: string
): Promise<number> {
  const { data, error } = await supabase.rpc('verifikat_without_documents', {
    p_company_id: companyId,
    p_since: since,
    p_min_amount: MISSING_UNDERLAG_MIN_GROSS_SEK,
    // p_limit only sizes the page; total_count is computed over the FULL
    // filtered set in an independent CTE, so 1 is the cheapest valid size.
    p_limit: 1,
    p_offset: 0,
  })
  if (error) throw new Error(`verifikat_without_documents failed: ${error.message}`)
  const result = data as { ok?: boolean; code?: string; total_count?: number } | null
  if (!result?.ok) {
    throw new Error(`verifikat_without_documents failed: ${result?.code ?? 'unknown error'}`)
  }
  return result.total_count ?? 0
}

/**
 * Posted verifikat dated within [start, end] that genuinely lack an underlag
 * and whose gross reaches MISSING_UNDERLAG_MIN_GROSS_SEK.
 *
 * BFL 5 kap 6-7 §: every affärshändelse needs a verifikation, and the
 * verifikation must reference its underlag. This delegates to the
 * `verifikat_without_documents` RPC, the SINGLE owner of that predicate: the
 * same SQL behind the web worklist badge (countVerifikatMissingDocument) and
 * behind gnubok_list_verifikat_without_documents. It carries three things a
 * hand-rolled scan here kept getting wrong:
 *
 *   1. the needs-doc source types (mirrors NEEDS_DOC_SOURCE_TYPES,
 *      lib/worklist/categories.ts, pinned by
 *      tests/pg/document-surfaces-unification.pg.test.ts). The local list read
 *      'supplier_invoice' and 'receipt', which are not members of the
 *      journal_entries.source_type CHECK at all: PostgREST matched zero rows,
 *      so supplier-invoice verifikat NEVER surfaced here and the momsperiod
 *      got a clean bill of health on exactly the entry types most likely to be
 *      missing their underlag;
 *   2. is_current_version, so a superseded document version does not silence
 *      the warning, and journal_entry_no_doc_required, so an explicit user
 *      waiver does;
 *   3. BFL 5 kap 7 § hänvisning till underlag: a payment verifikat whose
 *      supplier invoice carries an anchored document is covered by that
 *      document even though the doc row hangs on the registration verifikat.
 *      Without this, adding supplier_invoice_paid to the list would flag every
 *      paid supplier invoice in the period (the 2026-07-24 support case).
 *
 * The RPC takes `since` and no upper bound, so the in-period count is the
 * difference between two filter-respecting totals. Both calls run the same
 * predicate, so the subtraction is exact rather than an estimate.
 */
async function countMissingUnderlagInPeriod(
  supabase: SupabaseClient,
  companyId: string,
  start: string,
  end: string
): Promise<number> {
  const [fromStart, afterEnd] = await Promise.all([
    totalMissingUnderlagSince(supabase, companyId, start),
    totalMissingUnderlagSince(supabase, companyId, nextDay(end)),
  ])
  return Math.max(0, fromStart - afterEnd)
}

/**
 * Resolve the cash-account identity before comparing its bank feed with the
 * ledger. The cashAccountId is what prevents another same-currency account
 * from being included in the transaction total.
 *
 * The lookup itself lives in lib/reconciliation/cash-account-scope.ts so the
 * bokslut readiness aggregator (core code, which cannot import from
 * @/extensions/) resolves the scope the exact same way. It keeps the fail-closed
 * contract this function introduced in #1295: a cash_accounts lookup error
 * throws rather than degrading into the unscoped currency-only path.
 *
 * Pass accountNumber only when the CALLER named an account; leaving it
 * undefined means "the company's bank account", which additionally falls back
 * to the primary cash account for companies that have no 1930 row at all.
 */
export async function getScopedReconciliationStatus(
  supabase: SupabaseClient,
  companyId: string,
  dateFrom: string | undefined,
  dateTo: string | undefined,
  accountNumber?: string,
) {
  const scope = await resolveCashAccountScope(supabase, companyId, accountNumber)

  if (!scope.found && accountNumber !== undefined && accountNumber !== DEFAULT_SETTLEMENT_ACCOUNT) {
    // Coded: as a plain Error it reached agents as UNKNOWN_ERROR ("Försök
    // igen") for 1630, 1931, 1932 and 1940, and no retry finds an account the
    // company does not have. 1630 is the skattekonto, keyed on its own.
    throw codedRefusal('CASH_ACCOUNT_NOT_FOUND', `Okänt kassakonto ${accountNumber} för det här företaget`, {
      description: `No bank account of this company books to ${accountNumber}. Pick a ledger_account from gnubok_list_cash_accounts, or pass account_key "bank:<cash_account_id>" instead of account_number; the skattekonto (1630) is account_key "skattekonto".`,
      tool: 'gnubok_list_cash_accounts',
    })
  }

  const status = await getReconciliationStatus(
    supabase,
    companyId,
    dateFrom,
    dateTo,
    scope.accountNumber,
    scope.currency,
    scope.cashAccountId,
    scope.includeUnassigned,
  )

  return { status, scope }
}

export async function computeVatCloseCheck(
  args: Record<string, unknown>,
  companyId: string,
  supabase: SupabaseClient
): Promise<VatCloseCheckResult> {
  // 1) VAT report (validates inputs + gives us figures + period dates). The
  //    declaration it shows rides along for the completeness checks in step
  //    4b, which judge exactly the rutor that would be filed.
  const {
    report: vatReport,
    declaration,
    periodSource,
    excludedSettlementEntries,
  } = await computeVatReportWithRutor(args, companyId, supabase)
  const declarationRutor = declaration.rutor
  const { start, end, type: periodType, year, period } = vatReport.period

  // 2) Company settings: deadline inputs come from the same fields used by
  //    lib/tax/deadline-config.ts. The over-40M flag changes monthly filers
  //    from the 12th/17th M+2 schedule to the 26th M+1 schedule.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('moms_period, vat_taxable_base_over_40m, entity_type, fiscal_year_start_month, vat_has_eu_trade, vat_filing_method, accounting_method')
    .eq('company_id', companyId)
    .single()
  const momsPeriod = (settings?.moms_period as 'monthly' | 'quarterly' | 'yearly' | null) ?? null
  const entityType = isEntityType(settings?.entity_type) ? settings.entity_type : null
  // 3) Deadline: based on the *requested* period type, not company setting,
  //    so the model gets the right deadline even when querying ad-hoc periods.
  //    Never turn missing settings into a plausible statutory date. Monthly
  //    deadlines need the turnover threshold; annual deadlines additionally
  //    need the filing profile and a configured fiscal year matching the
  //    report range. Quarterly dates are independent of company settings.
  const configuredStartMonth = typeof settings?.fiscal_year_start_month === 'number'
    && settings.fiscal_year_start_month >= 1
    && settings.fiscal_year_start_month <= 12
    ? settings.fiscal_year_start_month
    : null
  // EU trade in the period's own rutor (20, 21, 37, 35, 38, 39) moves a
  // yearly deadline earlier whatever the setting says: the setting is a
  // statement about the books, and the books are at hand (crm#1171, #1139).
  const ledgerEuTrade = euTradeInRutor(declarationRutor)
  const periodHasEuTrade = ledgerEuTrade.purchases.length > 0 || ledgerEuTrade.sales.length > 0
  let deadline: { date: string; label: string } | null = null
  if (periodType === 'quarterly') {
    deadline = computeMomsDeadline('quarterly', Number(year), Number(period), {
      vat_taxable_base_over_40m: false,
    })
  } else if (
    periodType === 'monthly'
    && typeof settings?.vat_taxable_base_over_40m === 'boolean'
  ) {
    deadline = computeMomsDeadline('monthly', Number(year), Number(period), {
      vat_taxable_base_over_40m: settings.vat_taxable_base_over_40m,
    })
  } else if (periodType === 'yearly' && settings && entityType) {
    const reportEndMonth = Number(end.slice(5, 7))
    const reportStartMonth = reportEndMonth === 12 ? 1 : reportEndMonth + 1
    const calendarYearOnly = fiscalYearLockedToCalendar(entityType)
    const fiscalYearMatches = calendarYearOnly
      ? reportEndMonth === 12
      : configuredStartMonth === reportStartMonth
    const euTrade = helarsmomsHasEuTrade(settings.vat_has_eu_trade, periodHasEuTrade)
    const filingMethodRequired = !calendarYearOnly && !euTrade
    const filingProfileComplete = (euTrade || typeof settings.vat_has_eu_trade === 'boolean')
      && (!filingMethodRequired
        || settings.vat_filing_method === 'electronic'
        || settings.vat_filing_method === 'paper')

    if (fiscalYearMatches && filingProfileComplete) {
      const deadlineSettings: VatDeadlineCalculationSettings = {
        vat_taxable_base_over_40m: settings.vat_taxable_base_over_40m === true,
        entity_type: entityType,
        fiscal_year_start_month: reportStartMonth,
        vat_has_eu_trade: euTrade,
        vat_filing_method: settings.vat_filing_method,
      }
      deadline = computeMomsDeadline('yearly', Number(year), Number(period), deadlineSettings)
    }
  }
  if (!deadline) {
    log.warn('VAT deadline unavailable', {
      companyId,
      periodType,
      hasSettings: Boolean(settings),
      settingsErrorCode: settingsError?.code,
    })
  }

  // Kontantmetoden (bokslutsmetoden) has no attest step: a supplier invoice's
  // ingående moms is recognised when it is paid, and at the räkenskapsår's
  // end every invoice still unpaid at balansdagen is booked by the year-end
  // cut-off (BFL 5 kap 2 §). Whether that is done is the cut-off's own
  // finding, KONTANTMETOD_CUTOFF_INCOMPLETE in step 4b, over attested and
  // unattested invoices alike. Counting unattested invoices here instead sent
  // the agent to attest, a step that books nothing (#88).
  const cashMethod = settings?.accounting_method === 'cash'

  // 4) Blocker scans: run in parallel
  const [unbooked, unapprovedRes, recon, missingUnderlag, unattributedEuSales] = await Promise.all([
    // The shared "no verifikat" predicate (lib/transactions/unbooked.ts), the
    // same one the period-lock guard, attention and report data_status use.
    // The local journal_entry_id IS NULL count it replaced also counted
    // private rows and bulk-booked rows anchored via transaction_voucher_links.
    countUnbookedBankTransactions(supabase, companyId, { fromDate: start, toDate: end }),
    // Unattested supplier invoices dated in the period, where there is an
    // attest step at all (not under kontantmetoden, above).
    cashMethod
      ? Promise.resolve(null)
      : supabase
          .from('supplier_invoices')
          .select('id', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .eq('status', 'registered')
          .gte('invoice_date', start)
          .lte('invoice_date', end),
    // No account_number argument: the close check wants "the company's bank
    // account", so the scope resolver may land on the primary cash account for
    // a company that has no 1930 row.
    getScopedReconciliationStatus(supabase, companyId, start, end),
    // Verifikat in the period that genuinely lack an underlag (BFL 5 kap
    // 6-7 §), counted over the SHARED SQL predicate. Never re-derive this
    // locally: countMissingUnderlagInPeriod documents what the hand-rolled
    // scan that used to sit here got wrong.
    countMissingUnderlagInPeriod(supabase, companyId, start, end),
    // EU sales in rutor 35/38/39 that the periodisk sammanställning has no
    // buyer for (crm#1362), found by the PS itself over this momsperiod. Asked
    // only when the declaration holds EU sales at all.
    ledgerEuTrade.sales.length > 0
      ? findUnattributedEuSales(supabase, companyId, start, end).catch((err: unknown) => {
          log.warn('periodisk sammanställning check unavailable', {
            companyId,
            error: err instanceof Error ? err.message : String(err),
          })
          return null
        })
      : Promise.resolve([] as PsWarning[]),
  ])

  const blockers: VatCloseBlocker[] = []
  if (!deadline) {
    blockers.push({
      kind: 'deadline_unavailable',
      severity: 'high',
      count: 1,
      message: 'Momsens inlämningsdatum kunde inte fastställas säkert',
      hint: 'Kontrollera momsinställningar, deklarationssätt och räkenskapsperiod innan deklarationen lämnas in.',
    })
  }
  // The deadline above follows the books. The stored deadline rows follow them
  // once the nightly pass has recorded the year's EU trade
  // (vat_eu_trade_fiscal_years), while the earlier date is still ahead.
  if (periodType === 'yearly' && periodHasEuTrade && settings?.vat_has_eu_trade !== true) {
    blockers.push({
      kind: 'eu_trade_setting_off',
      severity: 'medium',
      count: ledgerEuTrade.purchases.length + ledgerEuTrade.sales.length,
      message:
        `Perioden har handel med andra EU-länder (${formatEuTradeBoxes(ledgerEuTrade)}) men inställningen ` +
        'Handel med andra EU-länder är av. Med EU-handel ska årsmomsen lämnas tidigare' +
        `${deadline ? `, senast ${deadline.label}` : ''}. Deadlinelistan flyttar datumet när den nattliga körningen ser EU-handeln i bokföringen, så länge det tidigare datumet inte har passerat.`,
      hint: 'Slå på vat_has_eu_trade med gnubok_update_company_tax_profile (eller Inställningar, Moms) så stämmer inställningen med bokföringen.',
    })
  }
  // Helårsmoms follows the räkenskapsår (SFL 26 kap 10-11 §§). When no fiscal
  // year ends in `year` the report silently fell back to Jan-Dec, which for a
  // company whose fiscal year does not start in January means every figure
  // above describes the wrong period (feedback seq 330091: FY Apr-Mar, yearly
  // 2026 came back as 2026-01-01..2026-12-31). Say so instead of leaving the
  // agent to infer it from an unavailable deadline.
  if (
    periodType === 'yearly'
    && periodSource === 'calendar_fallback'
    && configuredStartMonth !== null
    && configuredStartMonth !== 1
  ) {
    blockers.push({
      kind: 'fiscal_year_not_found',
      severity: 'high',
      count: 1,
      message: `Inget räkenskapsår som slutar ${year} hittades: perioden föll tillbaka på kalenderåret ${start}..${end}, men helårsmoms redovisas per räkenskapsår (SFL 26 kap 10-11 §§)`,
      hint: `Företagets räkenskapsår börjar månad ${configuredStartMonth}. Kontrollera räkenskapsåren med gnubok_list_fiscal_periods och ange year = det år räkenskapsåret slutar.`,
    })
  }
  const uncategorizedCount = unbooked.total
  if (uncategorizedCount > 0) {
    blockers.push({
      kind: 'uncategorized_transactions',
      severity: 'high',
      count: uncategorizedCount,
      message: `${uncategorizedCount} banktransaktioner i perioden saknar verifikat`,
      hint: UNCATEGORIZED_TRANSACTIONS_HINT,
    })
  }
  const unapprovedCount = unapprovedRes?.count ?? 0
  if (unapprovedCount > 0) {
    blockers.push({
      kind: 'unapproved_supplier_invoices',
      severity: 'high',
      count: unapprovedCount,
      message: `${unapprovedCount} oattesterade leverantörsfakturor i perioden`,
      hint: 'Attestera via gnubok_approve_supplier_invoice: ingående moms (ruta 48) påverkas.',
    })
  }
  const reconRes = recon.status
  // Verifikat dated before the bank's history (crm#1221) are outside Stäm
  // av's comparison, but this gate keeps reading them as verifikat without a
  // bank row (crm#185): the period's figures are exactly what they were
  // before that split, so a momsperiod the bank never covered stays closed.
  const beforeHistoryCount = reconRes.before_history_count ?? 0
  const ledgerWithoutBankRow = reconRes.unmatched_gl_line_count + beforeHistoryCount
  const periodDifference = roundOre(reconRes.difference - (reconRes.before_history_total ?? 0))
  if (!reconRes.is_reconciled || beforeHistoryCount > 0) {
    // Every bank row is matched and verifikat without a bank row explain the
    // whole difference (the residual is under half an öre, the Stäm av
    // sign-off threshold). The bridge calls that avstämt, so the user can sign
    // the month off, yet the gate stays closed: the bank side is missing for
    // those dates. Same gate and severity; the message names the situation and
    // the hint the action that clears it (crm#185).
    const bankRowsMissing =
      reconRes.unmatched_transaction_count === 0 &&
      ledgerWithoutBankRow > 0 &&
      typeof reconRes.unexplained_difference === 'number' &&
      Math.abs(reconRes.unexplained_difference) < 0.005
    // Nothing is left to match, and the whole difference is verifikat that
    // are settled against a rättelse dated outside the period (crm#1074).
    // The gate itself is unchanged (the period's bank and ledger movements do
    // differ); only the message names what it is, so it does not read as
    // "0 omatchade" with a difference and send the agent off to match.
    const settledElsewhere =
      reconRes.unmatched_transaction_count === 0 &&
      ledgerWithoutBankRow === 0 &&
      (reconRes.settled_gl_entry_count ?? 0) > 0 &&
      typeof reconRes.unexplained_difference === 'number' &&
      Math.abs(reconRes.unexplained_difference) < 0.005
    blockers.push({
      kind: 'bank_unreconciled',
      severity: Math.abs(periodDifference) > 100 ? 'high' : 'medium',
      count:
        reconRes.unmatched_transaction_count +
        ledgerWithoutBankRow +
        (settledElsewhere ? reconRes.settled_gl_entry_count : 0),
      // The account is named from the RESOLVED scope, not hard-coded: for a
      // company with no 1930 row this check now reconciles its primary cash
      // account, and a message pointing at 1930 would send the user to an
      // account with no lines on it.
      message: settledElsewhere
        ? `${reconRes.settled_gl_entry_count} verifikat på ${recon.scope.accountNumber} är kopplade mot verifikat daterade utanför perioden: periodens differens ${AGENT_AMOUNT_FORMAT.format(periodDifference)} kr är rättad i en annan period`
        : bankRowsMissing
        ? `${ledgerWithoutBankRow} verifikat på ${recon.scope.accountNumber} saknar banktransaktion: banken har inga rader för de datumen`
        : `Bankavstämning visar differens ${periodDifference.toFixed(2)} kr (${reconRes.unmatched_transaction_count} omatchade banktransaktioner, ${ledgerWithoutBankRow} omatchade huvudbokslinjer på ${recon.scope.accountNumber})`,
      hint: settledElsewhere
        ? SETTLED_ELSEWHERE_HINT
        : bankRowsMissing
        ? BANK_ROWS_MISSING_HINT
        : 'Granska via gnubok_get_reconciliation_status och matcha: moms beräknas från huvudboken så differenser döljer fel.',
    })
  }
  if (missingUnderlag > 0) {
    blockers.push({
      kind: 'missing_high_value_receipts',
      severity: 'medium',
      count: missingUnderlag,
      message: `${missingUnderlag} verifikat över ${MISSING_UNDERLAG_MIN_GROSS_SEK} kr saknar underlag`,
      hint: `BFL 5 kap 6-7 §: varje affärshändelse måste ha en verifikation med hänvisning till sitt underlag. Lista dem med gnubok_list_verifikat_without_documents (via gnubok_call_tool; since=${start}, min_amount=${MISSING_UNDERLAG_MIN_GROSS_SEK}) och para ihop via gnubok_list_unmatched_documents.`,
    })
  }
  // The periodisk sammanställning is the per-buyer breakdown of rutor 35, 38
  // and 39 and a filing of its own: a sale those rutor count with no buyer
  // to file it under means the two filings disagree. Until crm#1362 nothing
  // here read the PS, so such a period answered ready with no finding.
  const euSaleBlockers = unattributedEuSaleBlockers(unattributedEuSales)
  blockers.push(...euSaleBlockers)
  // Untagged verifikat the report classified as momsredovisning BY SHAPE and
  // therefore kept out of the rutor. Informational (severity low, never part
  // of ready_to_close): a manual or imported settlement is supposed to be
  // excluded. It is named because shape is an inference, not a recorded intent
  // (#2805): when a ruta disagrees with the general ledger, these are the
  // verifikat that explain it, and until now nothing pointed at them. Tagged
  // vat_settlement entries are left out: the app booked those itself.
  const shapeDetectedEntries = excludedSettlementEntries.filter((e) => e.detected_by !== 'tagged')
  if (shapeDetectedEntries.length > 0) {
    const named = shapeDetectedEntries
      .slice(0, EXCLUDED_SETTLEMENT_ENTRIES_CAP)
      .map((e) => `${e.voucher_label} (${e.entry_date})`)
      .join(', ')
    const more = shapeDetectedEntries.length > EXCLUDED_SETTLEMENT_ENTRIES_CAP
      ? ` och ${shapeDetectedEntries.length - EXCLUDED_SETTLEMENT_ENTRIES_CAP} till`
      : ''
    blockers.push({
      kind: 'momsredovisning_entries_excluded',
      severity: 'low',
      count: shapeDetectedEntries.length,
      message: `Information: ${shapeDetectedEntries.length} verifikat utan momsredovisningstagg är klassade som momsredovisning på formen och ingår inte i rutorna: ${named}${more}`,
      hint: 'Blockerar inte. Formen är ett momskonto mot 2650/1650, eller enbart 26xx mot skattekontot 1630. Skiljer sig en ruta från huvudboken är det dessa verifikat som förklarar skillnaden: granska dem med gnubok_query_journal.',
      entries: shapeDetectedEntries.slice(0, EXCLUDED_SETTLEMENT_ENTRIES_CAP),
    })
  }

  // 4b) Is the DECLARATION itself complete? Everything above is about the
  //     bookkeeping around it; this is about the momsdeklaration.
  //
  //     Until 2026-07 this was a single hand-rolled mirror,
  //     `acquisitionAndImportBase > 0 && ruta48 === 0`, and ruta 48 aggregates
  //     2641/2642/2645/2646/2647/2649: ONE ordinary domestic receipt in the
  //     period made it unreachable, so a declaration with omvänd
  //     skattskyldighet booked on one side only sailed through as "Klart för
  //     stängning". There was no basbelopp check (rutor 20-24 vs 30-32) at all,
  //     which is the FK004 case Skatteverket rejects.
  //
  //     Now the shared core checks run instead, over the full SKV 4700
  //     projection, so the MCP verdict is the SAME verdict the web UI's
  //     "Kontroll av underlaget" gate gives. Never re-derive these locally.
  //     A WARNING a person reviewed for the period (crm#1171) stays in
  //     declaration_checks with its review and leaves the blockers: it has
  //     been looked at. An ERROR is never reviewed.
  const {
    checks: declarationChecks,
    blocked: declarationBlocked,
    inputs: reviewInputs,
  } = await vatFilingVerdictWithReviews(supabase, companyId, declaration)

  // Zero deductible input VAT against self-assessed utgående moms is
  // unambiguous: rutor 30-32 (omvänd skattskyldighet, 2614/2624/2634) and
  // rutor 60-62 (import since 2015, 2615/2625/2635) each require the matching
  // ingående moms on 2645/2647 (ML 2023:200); with ruta 48 at zero there is no
  // partial-deduction story that explains it.
  //
  // The shared RC_INPUT_VAT_MISMATCH now isolates the RC share exactly (it reads
  // the declaration's 2645/2647 pair, rcInputAccountTotals) and still stays a WARNING,
  // deliberately: limited avdragsrätt (blandad verksamhet, ML 13 kap 18/24-25 §§)
  // makes a shortfall legally correct for some filers, and no SKV gateway rule
  // rejects it. Both halves of this escalation survive that sharpening:
  //   - the RC half turns the warning into a blocker in the one case where no
  //     deduction story exists at all (ruta 48 itself is zero);
  //   - the IMPORT half (rutor 60-62 against ruta 48, below) is coverage the
  //     shared checks still do not have: they compare import output only against
  //     the tullvärdesunderlag in ruta 50, never against the input side.
  const eps = 0.5
  const rcOutput = declarationRutor.ruta30 + declarationRutor.ruta31 + declarationRutor.ruta32
  const noInputVatAtAll = selfAssessedVatWithoutAnyInputVat(declarationRutor)

  for (const check of declarationChecks) {
    if (check.review) continue
    const escalated =
      check.status === 'ERROR' ||
      (check.code === 'RC_INPUT_VAT_MISMATCH' && noInputVatAtAll) ||
      // Kontantmetoden's year-end cut-off not booked (or not checkable):
      // filed now, the moms on invoices unpaid at balansdagen is missing from
      // this period. A WARNING to the filing gate (founder decision
      // 2026-10-03), but the close is not ready, which the unattested-invoice
      // count used to say at the year end (agent feedback seq 878478, #88).
      check.code === 'KONTANTMETOD_CUTOFF_INCOMPLETE'
    const baseHint =
      // Moms booked but under a krona: nothing in the ledger to review or fix.
      check.belowOneKrona
        ? VAT_BELOW_ONE_KRONA_HINT
        : // Only the blocking variant: the advisory RC_BASIS_MISSING (period
      // consistent per rate) and the scan-unavailable one must not be told to
      // add basis pairs, that would double-count rutor 20-24.
      check.code === 'RC_BASIS_MISSING' && check.status === 'ERROR'
        ? (rcOutput < 0 ? RC_BASIS_NEGATIVE_HINT : RC_BASIS_MISSING_HINT)
        : check.code === 'RC_BASIS_MISSING' && isReviewableVatCheck(check, reviewInputs)
          ? RC_BASIS_ADVISORY_HINT
          : check.code === 'REVENUE_ACCOUNT_WITHOUT_RUTA'
            ? REVENUE_ACCOUNT_WITHOUT_RUTA_HINT
            : check.code === 'VAT_ACCOUNT_WITHOUT_RUTA'
              ? VAT_ACCOUNT_WITHOUT_RUTA_HINT
              : check.code === 'KONTANTMETOD_CUTOFF_INCOMPLETE'
              ? KONTANTMETOD_CUTOFF_HINT
              : check.rutor?.length
                ? `Granska ${check.rutor.join(', ')} i huvudboken innan inlämning (gnubok_get_general_ledger).`
                : 'Granska underlaget i huvudboken innan inlämning (gnubok_get_general_ledger).'
    blockers.push({
      kind: RC_COMPLETENESS_CODES.has(check.code)
        ? 'reverse_charge_input_missing'
        : 'declaration_incomplete',
      severity: escalated ? 'high' : 'medium',
      count: 1,
      message: check.message,
      // The review pointer, except where the finding has its own way out:
      // RC_BASIS_MISSING's advisory hint names the review itself, and an
      // account without a ruta is fixed on the account, not accepted.
      hint: !escalated &&
        isReviewableVatCheck(check, reviewInputs) &&
        check.code !== 'RC_BASIS_MISSING' &&
        check.code !== 'REVENUE_ACCOUNT_WITHOUT_RUTA' &&
        check.code !== 'VAT_ACCOUNT_WITHOUT_RUTA'
        ? `${baseHint} ${VAT_CHECK_REVIEW_HINT}`
        : baseHint,
      check_code: check.code,
    })
  }

  // Import-only variant of the same defect: no RC output means no
  // RC_INPUT_VAT_MISMATCH finding exists to escalate above.
  if (noInputVatAtAll && rcOutput <= eps) {
    blockers.push({
      kind: 'reverse_charge_input_missing',
      severity: 'high',
      count: 1,
      message:
        'Import: utgående importmoms är bokförd (ruta 60/61/62) men ingen avdragsgill ingående moms alls (ruta 48 är noll)',
      hint: 'ML 2023:200: importören redovisar både beräknad utgående moms (2615/2625/2635) och avdragsgill ingående moms (2645).',
    })
  }

  // 5) Sanity: this period's sales per rate against the previous period of
  //    the same length (compareVatPeriods). Advisory, never a blocker, so a
  //    failed read of the previous period leaves the comparison out; it is
  //    logged, and previous_period_compared says so.
  let previousRutor: VatSanityRutor | null = null
  const prevArgs = previousPeriodArgs(periodType as 'monthly' | 'quarterly' | 'yearly', Number(year), Number(period))
  if (prevArgs) {
    try {
      previousRutor = (await computeVatReport(prevArgs, companyId, supabase)).rutor
    } catch (err) {
      log.warn('previous VAT period unavailable, sanity comparison skipped', {
        companyId,
        previousPeriod: prevArgs,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  const sanity = compareVatPeriods(vatReport.rutor, previousRutor)

  // Moms earlier periods left on 2650/1650 after Skatteverket charged or paid
  // it (lib/reports/vat-settlement-account-drift.ts). Read last, as today's
  // state of the books; a failed read leaves the close check as it was.
  try {
    const drift = await computeSettlementAccountDrift(supabase, companyId, todayIsoStockholm())
    const driftBlocker = settlementAccountDriftBlocker(drift)
    if (driftBlocker) blockers.push(driftBlocker)
  } catch (err) {
    log.warn('settlement account drift unavailable', { companyId, error: err instanceof Error ? err.message : String(err) })
  }

  const highBlockers = blockers.filter((b) => b.severity === 'high').length
  // Two gates, one verdict. vatFilingVerdict's `blocked`, the same verdict every
  // filing path refuses on, is authoritative for the declaration itself; the
  // blocker scan covers the bookkeeping around it. An ERROR finding is already
  // a high blocker, so this is belt and braces on purpose: the readiness answer
  // must never come from a narrower source than the filing gate's.
  const readyToClose = highBlockers === 0 && !declarationBlocked
  // What reaches the skattekonto is ruta 49 as filed: every ruta in whole
  // kronor and 49 their net (buildFiledAmounts), the amount the momsverifikat
  // books on 2650/1650. The öre sum of the rutor can differ from it by a
  // krona or two, and naming that one made the close check and the
  // settlement disagree (crm#1171).
  const netDue = buildFiledAmounts(declarationRutor).net
  const direction: 'pay' | 'refund' | 'zero' = netDue > 0 ? 'pay' : netDue < 0 ? 'refund' : 'zero'

  const declarationErrors = declarationChecks.filter((c) => c.status === 'ERROR').length
  // A ruta 39 sale without a buyer does not stop the close, but "klart" must
  // not read as "nothing for the periodisk sammanställning" (crm#1362).
  const psWarning = euSaleBlockers.find((b) => b.severity !== 'high')
  const psNote = !psWarning
    ? ''
    : psWarning.count > 0
      ? ` Periodisk sammanställning: ${psWarning.count} EU-försäljning${psWarning.count === 1 ? '' : 'ar'} i ruta 39 saknar köpare.`
      : ' Periodisk sammanställning kunde inte stämmas av.'
  let summary: string
  if (readyToClose && sanity.anomalies.length === 0) {
    summary = `Klart för stängning. ${direction === 'pay' ? `Moms att betala: ${netDue} kr` : direction === 'refund' ? `Moms att få tillbaka: ${Math.abs(netDue)} kr` : 'Noll i moms'}.${deadline ? ` Inlämning senast ${deadline.label}.` : ''}${psNote}`
  } else if (readyToClose) {
    summary = `Klart för stängning men ${sanity.anomalies.length} avvikelse(r) att granska.${psNote}`
  } else if (declarationBlocked) {
    summary = `Inte klart: deklarationsunderlaget är ofullständigt (${declarationErrors} fel), ${highBlockers} kritiska blockerare totalt.`
  } else {
    summary = `Inte klart: ${highBlockers} kritiska blockerare.`
  }

  return {
    period: { ...vatReport.period, source: periodSource },
    period_label: vatReport.period_label,
    rutor: vatReport.rutor,
    payment: {
      net_due: netDue,
      direction,
      deadline: deadline?.date ?? null,
      deadline_label: deadline?.label ?? null,
      moms_period: momsPeriod,
    },
    blockers,
    declaration_checks: toCompletenessFindings(declarationChecks, reviewInputs),
    sanity,
    ready_to_close: readyToClose,
    summary,
  }
}

function previousPeriodArgs(
  periodType: 'monthly' | 'quarterly' | 'yearly',
  year: number,
  period: number
): { period_type: string; year: number; period: number } | null {
  if (periodType === 'monthly') {
    if (period === 1) return { period_type: 'monthly', year: year - 1, period: 12 }
    return { period_type: 'monthly', year, period: period - 1 }
  }
  if (periodType === 'quarterly') {
    if (period === 1) return { period_type: 'quarterly', year: year - 1, period: 4 }
    return { period_type: 'quarterly', year, period: period - 1 }
  }
  if (periodType === 'yearly') {
    return { period_type: 'yearly', year: year - 1, period: 1 }
  }
  return null
}
